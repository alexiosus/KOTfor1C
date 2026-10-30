import { vanessaFormReplyText } from './vanessaControlForms';
import { parseVanessaClientProfiles } from './vanessaControlClients';
import { createHash } from 'node:crypto';
import { sameVanessaFeaturePath } from './vanessaControlProtocol';

export type VanessaDiagnosticTool = 'get_vanessa_automation_state' | 'get_environment_data' | 'manage_test_client_profiles' | 'get_test_results'
    | 'get_event_log_manager' | 'get_event_log_test_client' | 'search_for_steps_by_keywords' | 'check_syntax' | 'get_window_list_os' | 'get_window_screenshot_os';
export interface VanessaDiagnosticPorts {
    isCurrent(): boolean;
    supported(tool: VanessaDiagnosticTool): boolean;
    request(tool: VanessaDiagnosticTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
    /** Supplies an owned local file; the callback never selects a path from a server reply. */
    screenshotFile?(capture: (filePath: string) => Promise<Buffer | undefined>): Promise<Buffer>;
}
export interface VanessaDiagnosticSection { readonly tool: VanessaDiagnosticTool; readonly status: 'available' | 'unavailable' | 'error'; readonly text?: string }
export interface VanessaDiagnosticReport { readonly schemaVersion: 1; readonly createdAt: string; readonly sections: readonly VanessaDiagnosticSection[] }
export interface VanessaDiagnosticWindows { readonly client: string; readonly titles: readonly string[] }
export class VanessaDiagnosticError extends Error {}

/** Remove entire credential-bearing lines, rather than trying to preserve arbitrary quoted values. */
export function redactVanessaDiagnosticText(text: string): string {
    let continuation: { indentation: number; awaitingValue: boolean } | undefined;
    return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').split(/\r\n|\r|\n/u).map(line => {
        let check = line;
        for (let n = 0; n < 2; n++) { try { check = decodeURIComponent(check); } catch { break; } }
        check = check.replace(/\\+["']/gu, '"');
        const secret = /(?:^|[\s"'|;?&,\[{])(?:--?)?(?:[a-z\d]+[_-])*(?:password|pwd|пароль|token|api[_ -]?key|authorization|secret|access[_-]?token|refresh[_-]?token)\s*["']?\s*(?:[:=]|(?=\s+\S))/iu.test(check)
            || /\bBearer\s+\S+|(?:^|[\s"'\[,])\/P\S*|https?:\/\/[^\s/]+:[^\s/]*@/iu.test(check)
            || /строка подключения|строка соединения с информационной базой|дополнительные параметры|connection string|additional parameters/iu.test(check);
        const indentation = /^\s*/u.exec(check)![0].length;
        if (secret) {
            continuation = /[:=]\s*(?:[|>][-+]?|[\[{])?\s*$/u.test(check) ? { indentation, awaitingValue: true } : undefined;
            return '[redacted]';
        }
        if (continuation && check.trim()) {
            if (continuation.awaitingValue || indentation > continuation.indentation) {
                continuation.awaitingValue = false; return '[redacted]';
            }
            continuation = undefined;
        }
        return line;
    }).join('\n');
}

/** Explicit bounded reads; never poll logs, retain raw responses or turn unknown prose into a pass. */
export class VanessaRuntimeDiagnostics {
    constructor(private readonly ports: VanessaDiagnosticPorts) {}
    private current(signal?: AbortSignal) {
        signal?.throwIfAborted();
        if (!this.ports.isCurrent()) { throw new VanessaDiagnosticError('The Vanessa session changed. Collect diagnostics again.'); }
    }
    private async raw(tool: VanessaDiagnosticTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
        this.current(signal);
        if (!this.ports.supported(tool)) { throw new VanessaDiagnosticError('This Vanessa session does not support the requested diagnostic tool.'); }
        const reply = await this.ports.request(tool, args, signal); this.current(signal);
        return reply;
    }
    private async read(tool: VanessaDiagnosticTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
        return redactVanessaDiagnosticText(vanessaFormReplyText(await this.raw(tool, args, signal)));
    }
    async collect(options: { managerLog?: boolean; clientLog?: boolean } = {}, signal?: AbortSignal): Promise<VanessaDiagnosticReport> {
        const sections: VanessaDiagnosticSection[] = [];
        const requests: Array<[VanessaDiagnosticTool, Record<string, unknown>]> = [
            ['get_vanessa_automation_state', {}], ['get_environment_data', {}], ['manage_test_client_profiles', { action: 'get_list' }], ['get_test_results', {}]
        ];
        const log = { limit: 100, scan_limit: 500, columns: 'date|level|event|comment', display_order: 'desc' };
        if (options.managerLog) { requests.push(['get_event_log_manager', log]); }
        if (options.clientLog) { requests.push(['get_event_log_test_client', log]); }
        for (const [tool, args] of requests) {
            this.current(signal);
            if (!this.ports.supported(tool)) { sections.push({ tool, status: 'unavailable' }); continue; }
            try { sections.push({ tool, status: 'available', text: await this.read(tool, args, signal) }); }
            catch {
                this.current(signal);
                const text = tool === 'get_event_log_test_client' ? 'Could not read the client log. It requires a connected test client with VAExtension 1.40 or later.'
                    : tool === 'get_event_log_manager' ? 'Could not read the manager log. The manager user needs EventLog access.' : undefined;
                sections.push({ tool, status: 'error', ...(text ? { text } : {}) });
            }
        }
        this.current(signal);
        return Object.freeze({ schemaVersion: 1, createdAt: new Date().toISOString(), sections: Object.freeze(sections) });
    }
    async search(query: string, signal?: AbortSignal): Promise<string> {
        if (!query.trim() || query.length > 256 || /[\r\n\u0000]/u.test(query)) { throw new VanessaDiagnosticError('Enter a step name to search in the running Vanessa.'); }
        return this.read('search_for_steps_by_keywords', { search_name: query.trim(), limit: 50 }, signal);
    }
    async checkSyntax(filePath: string, signal?: AbortSignal): Promise<string> {
        if (!filePath || !/\.feature$/iu.test(filePath) || /[\r\n\u0000]/u.test(filePath)) { throw new VanessaDiagnosticError('Open a saved feature file before runtime syntax validation.'); }
        const text = await this.read('check_syntax', { filePath }, signal);
        try {
            const envelope = JSON.parse(text);
            if (typeof envelope?.message === 'string' && typeof envelope.completedAt === 'string') { return redactVanessaDiagnosticText(envelope.message); }
        } catch { /* Other versions can return plain Markdown instead of this .45 envelope. */ }
        return text;
    }
    private async client(signal?: AbortSignal): Promise<string> {
        const clients = parseVanessaClientProfiles(await this.raw('manage_test_client_profiles', { action: 'get_list' }, signal)).filter(client => client.connected);
        if (clients.length !== 1) { throw new VanessaDiagnosticError('Select one connected test client before taking a screenshot.'); }
        return createHash('sha256').update(JSON.stringify(clients[0])).digest('hex');
    }
    async windows(signal?: AbortSignal): Promise<VanessaDiagnosticWindows> {
        const client = await this.client(signal);
        const text = vanessaFormReplyText(await this.raw('get_window_list_os', {}, signal)).trim();
        const count = /^Для снятия скриншотов найдено ([1-9]\d*) окон:\n/u.exec(text)?.[1];
        const titles = [...text.matchAll(/^  -([^\r\n]+)$/gmu)].map(match => match[1]);
        if (!count || Number(count) !== titles.length || titles.length > 100 || new Set(titles.map(title => title.toLocaleLowerCase())).size !== titles.length || client !== await this.client(signal)) {
            throw new VanessaDiagnosticError('The test-client windows were not confirmed. Refresh the window list.');
        }
        return Object.freeze({ client, titles: Object.freeze(titles) });
    }
    async screenshot(windows: VanessaDiagnosticWindows, title: string, signal?: AbortSignal): Promise<Buffer> {
        const current = await this.windows(signal);
        if (current.client !== windows.client || !windows.titles.includes(title) || !current.titles.includes(title)) {
            throw new VanessaDiagnosticError('The selected client or window changed. Select the window again.');
        }
        const capture = async (filePath?: string): Promise<Buffer | undefined> => {
            const reply = await this.raw('get_window_screenshot_os', { window_title: title, color_mode: 'color', ...(filePath ? { file_name: filePath } : {}) }, signal) as { isError?: boolean; content?: Array<{ type?: string; mimeType?: string; data?: string }> } | undefined;
            const images = reply?.content?.filter(block => block.type === 'image');
            if (!images?.length && filePath) {
                const target = /^Скриншот окна записан в файл: ([^\r\n]+)$/mu.exec(vanessaFormReplyText(reply))?.[1];
                if (target && sameVanessaFeaturePath(target, filePath)) { return; }
            }
            if (reply?.isError || images?.length !== 1 || images[0].mimeType !== 'image/png' || typeof images[0].data !== 'string' || images[0].data.length > 32_000_000) {
                throw new VanessaDiagnosticError('Vanessa did not return a supported PNG screenshot. File-only replies require KOT and Vanessa on the same computer.');
            }
            const encoded = images[0].data.replace(/[\r\n]/gu, ''); const image = Buffer.from(encoded, 'base64');
            if (image.toString('base64') !== encoded) { throw new VanessaDiagnosticError('Vanessa did not return a supported PNG screenshot.'); }
            return image;
        };
        const data = this.ports.screenshotFile ? await this.ports.screenshotFile(capture) : await capture();
        if (!data || data.length > 24_000_000) { throw new VanessaDiagnosticError('Vanessa did not return a supported PNG screenshot.'); }
        if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) { throw new VanessaDiagnosticError('Vanessa did not return a supported PNG screenshot.'); }
        const after = await this.windows(signal);
        if (after.client !== windows.client || !after.titles.includes(title)) { throw new VanessaDiagnosticError('The selected client or window changed. Select the window again.'); }
        return data;
    }
}
