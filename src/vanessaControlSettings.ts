import { vanessaFormReplyText } from './vanessaControlForms';

export interface VanessaSetting {
    readonly key: string; readonly path: string; readonly synonym: string; readonly current: string;
    readonly hint?: string; readonly editable?: boolean; readonly settable: boolean; readonly password_mode?: boolean;
    readonly allowed_values?: readonly unknown[];
}
export interface VanessaSettingsReply {
    readonly ok: boolean; readonly revision: number; readonly items?: readonly VanessaSetting[]; readonly item?: VanessaSetting;
    readonly errors: readonly unknown[]; readonly warnings: readonly unknown[]; readonly out_of_scope: readonly unknown[];
    readonly ignored: readonly unknown[]; readonly changed: readonly unknown[]; readonly applied: readonly unknown[];
    readonly dry_run?: boolean;
}
export function parseVanessaSettings(reply: unknown): VanessaSettingsReply {
    const data: unknown = JSON.parse(vanessaFormReplyText(reply));
    if (!data || typeof data !== 'object') { throw new Error('Unconfirmed Vanessa settings response.'); }
    const row = data as VanessaSettingsReply;
    if (typeof row.ok !== 'boolean' || !Number.isSafeInteger(row.revision) || row.revision < 0 ||
        ['errors', 'warnings', 'out_of_scope', 'ignored', 'changed', 'applied'].some(key => !Array.isArray((row as unknown as Record<string, unknown>)[key]))) {
        throw new Error('Unconfirmed Vanessa settings response.');
    }
    return row;
}
export class VanessaRuntimeSettings {
    constructor(private readonly request: (name: 'get_va_settings' | 'manage_va_settings', args: Record<string, unknown>) => Promise<unknown>) {}
    async list(query = ''): Promise<VanessaSettingsReply> {
        return parseVanessaSettings(await this.request('get_va_settings', { action: 'list', query, limit: 0, format: 'json' }));
    }
    async get(key: string): Promise<VanessaSettingsReply> {
        return parseVanessaSettings(await this.request('get_va_settings', { action: 'get', key, format: 'json' }));
    }
    async set(key: string, value: string, revision: number, current: string): Promise<VanessaSettingsReply> {
        return parseVanessaSettings(await this.request('manage_va_settings', { action: 'set', key, value,
            expected_revision: revision, expected_current_value: current, format: 'json' }));
    }
    async apply(parameters: string, basePath: string, revision: number, dryRun: boolean): Promise<VanessaSettingsReply> {
        const parsed: unknown = JSON.parse(parameters);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw new Error('VAParams must be a JSON object.'); }
        return parseVanessaSettings(await this.request('manage_va_settings', { action: 'apply', parameters_json: parameters,
            base_path: basePath, expected_revision: revision, dry_run: dryRun, format: 'json' }));
    }
}
