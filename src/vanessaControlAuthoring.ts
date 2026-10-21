import { vanessaFormReplyText } from './vanessaControlForms';
import { parseVanessaControlReply } from './vanessaControlProtocol';
export class VanessaAuthoringError extends Error {
    constructor(message: string, readonly uncertain = false, readonly token?: VanessaRecordingToken) { super(message); }
}
export interface VanessaRecordingToken { readonly generation: number; readonly client: string; readonly previousSteps?: string }
export interface VanessaAuthoringPorts {
    readonly generation: number;
    isCurrent(): boolean;
    client(): Promise<string>;
    formIdentity(): Promise<string>;
    request(tool: 'get_vanessa_automation_state' | 'user_actions_recording' | 'get_form_analysis', args: Record<string, unknown>): Promise<unknown>;
}
const fail = () => new VanessaAuthoringError('Vanessa authoring was not confirmed. Check the current client and recording state in Vanessa.');
function section(text: string, heading: string): string {
    const start = text.indexOf(heading + '\n');
    if (start < 0) { throw fail(); }
    const value = text.slice(start + heading.length + 1).split('\n## ')[0].trim();
    const fenced = /^```gherkin\n([\s\S]*?)\n```(?:\n|$)/u.exec(value);
    if (!fenced) { throw fail(); } return fenced[1].replace(/^\n+|\n+$/gu, '');
}
export class VanessaRuntimeAuthoring {
    constructor(private readonly ports: VanessaAuthoringPorts) {}
    private current() { if (!this.ports.isCurrent()) { throw fail(); } }
    private async request(tool: Parameters<VanessaAuthoringPorts['request']>[0], args: Record<string, unknown>) {
        this.current(); let reply: unknown;
        try { reply = await this.ports.request(tool, args); } catch { throw fail(); }
        this.current(); try { return vanessaFormReplyText(reply); } catch { throw fail(); }
    }
    private async recording(): Promise<boolean | undefined> {
        const text = await this.request('get_vanessa_automation_state', {});
        const matches = [...text.matchAll(/^- Включена запись действий пользователя: (Да|Нет|Истина|Ложь|true|false)$/gimu)];
        if (matches.length === 1) { return /^(?:да|истина|true)$/iu.test(matches[0][1]); }
        if (!matches.length && (text.startsWith('В редактор был загружен фича файл, но ещё ни разу не запускался.') ||
            parseVanessaControlReply('get_vanessa_automation_state', { content: [{ type: 'text', text }] }).kind === 'state')) {
            return undefined;
        }
        throw new VanessaAuthoringError('Vanessa did not return a readable recording state. Refresh the connection and check the current test client.');
    }
    private async stopAndRead(preserve: (steps: string) => void): Promise<string> {
        const text = await this.request('user_actions_recording', { action: 'stop' });
        if (!text.startsWith('# Запись действий остановлена\n') || !/^- Статус: запись выключена$/mu.test(text)) { throw fail(); }
        const steps = text.includes('- Записанные шаги: не обнаружено действий за время записи') ? '' : section(text, '## Записанные шаги (Turbo Gherkin)');
        preserve(steps);
        if (await this.recording() === true) { throw fail(); }
        return steps;
    }
    async start(): Promise<VanessaRecordingToken> {
        this.current(); const client = await this.ports.client(); this.current();
        const recording = await this.recording();
        if (recording === true) { throw new VanessaAuthoringError('Vanessa is already recording. Stop that capture in Vanessa before starting another.'); }
        let previousSteps: string | undefined;
        try {
        // .45 omits the flag before the first execution and Start is a toggle. The user
        // explicitly requested stop/preserve/start in this case, without a confirmation.
        if (recording === undefined) {
            await this.stopAndRead(steps => { previousSteps = steps; });
            if (client !== await this.ports.client()) { throw fail(); } this.current();
        }
        const text = await this.request('user_actions_recording', { action: 'start' });
        if (!text.startsWith('# Запись действий начата\n') || !/^- Статус: запись включена$/mu.test(text) || await this.recording() === false) { throw fail(); }
        if (client !== await this.ports.client()) { throw fail(); } this.current();
        return Object.freeze({ generation: this.ports.generation, client, ...(previousSteps ? { previousSteps } : {}) });
        } catch { throw new VanessaAuthoringError('Recording state was not confirmed. Check Vanessa or retry Stop recording.', true,
            { generation: this.ports.generation, client, ...(previousSteps ? { previousSteps } : {}) }); }
    }
    async stop(token: VanessaRecordingToken): Promise<string | null> {
        this.current(); if (token.generation !== this.ports.generation || token.client !== await this.ports.client()) { throw fail(); }
        this.current();
        // .45 finalizes the capture again on every Stop, replacing the saved
        // generated text with an empty recording. Leave an external Stop intact.
        if (await this.recording() === false) { return null; }
        let previousSteps = token.previousSteps;
        try {
        const text = await this.stopAndRead(steps => { if (steps) { previousSteps = steps; } });
        if (token.client !== await this.ports.client()) { throw fail(); } this.current();
        return text;
        } catch { throw new VanessaAuthoringError('Recording state was not confirmed. Check Vanessa or retry Stop recording.', true, { ...token, ...(previousSteps ? { previousSteps } : {}) }); }
    }
    async formSteps(kind: 'checks' | 'suggestions'): Promise<string> {
        this.current(); const before = await this.ports.formIdentity(); this.current();
        const text = await this.request('get_form_analysis', kind === 'checks' ? { format: 'gherkin' } : { format: 'full', compact: false, max_depth: 1 });
        if (before !== await this.ports.formIdentity()) { throw fail(); } this.current();
        return section(text, kind === 'checks' ? '## Gherkin-состояние формы' : '## Часто используемые шаги для текущего элемента');
    }
}
export function renderVanessaInsertion(steps: string, indentation: string, _language: 'en' | 'ru', eol = '\n'): string {
    const lines = steps.replace(/\r\n|\r/gu, '\n').split('\n');
    while (lines.length && !lines[0].trim()) { lines.shift(); } while (lines.length && !lines.at(-1)!.trim()) { lines.pop(); }
    if (!lines.length) { return ''; }
    const base = Math.min(...lines.filter(line => line.trim()).map(line => /^\s*/u.exec(line)![0].length));
    return lines.map(line => {
        const value = line.slice(Math.min(base, /^\s*/u.exec(line)![0].length));
        return indentation + value;
    }).join(eol) + eol;
}

export interface VanessaInsertionTarget {
    readonly uri: string; readonly version: number; readonly text: string;
    readonly offset: number; readonly length: number; readonly indentation: string; readonly language: 'en' | 'ru'; readonly eol: string;
}
export function prepareVanessaDraftInsertion(target: VanessaInsertionTarget, current: Pick<VanessaInsertionTarget, 'uri' | 'version' | 'text'>, steps: string) {
    if (target.uri !== current.uri || target.version !== current.version || target.text !== current.text || !Number.isSafeInteger(target.offset) ||
        !Number.isSafeInteger(target.length) || target.offset < 0 || target.length < 0 || target.offset + target.length > current.text.length) {
        throw new VanessaAuthoringError('The source changed during capture. Place the cursor in the intended scenario and use Insert captured steps here.');
    }
    return { offset: target.offset, length: target.length, text: renderVanessaInsertion(steps, target.indentation, target.language, target.eol) };
}
