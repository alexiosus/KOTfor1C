export type VanessaVariableScope = 'local' | 'global';
export interface VanessaRuntimeVariable { readonly scope: VanessaVariableScope; readonly name: string; readonly representation: string }
export interface VanessaVariablePorts {
    request(args: Readonly<Record<string, unknown>>): Promise<unknown>;
    isCurrent?(): boolean;
}
export class VanessaVariableControlError extends Error {}
function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function textReply(reply: unknown): string {
    const result = record(reply); const content = result?.content;
    if (result?.isError || !Array.isArray(content) || content.length !== 1) { throw unconfirmed(); }
    const block = record(content[0]);
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 1_000_000) { throw unconfirmed(); }
    return block.text.replace(/\r\n/gu, '\n');
}
const validName = (name: string) => typeof name === 'string' && /^[\p{L}_][\p{L}\p{N}_]{0,255}$/u.test(name);
const unconfirmed = () => new VanessaVariableControlError('The Vanessa variable operation was not confirmed. Refresh the variables.');

/** .45 returns untyped, unescaped representations. Never infer a 1C type from this text. */
export function parseVanessaVariables(reply: unknown): readonly VanessaRuntimeVariable[] {
    const lines = textReply(reply).split('\n');
    if (lines.shift() !== '# Переменные контекста') { throw unconfirmed(); }
    let scope: VanessaVariableScope | undefined; let empty = false;
    const seen = new Set<string>(); const headings = new Set<VanessaVariableScope>();
    const variables: VanessaRuntimeVariable[] = [];
    for (const line of lines) {
        if (!line.trim()) { continue; }
        if (line === '## Контекст ($var$)' || line === '## Сохраняемый контекст ($$var$$)') {
            scope = line === '## Контекст ($var$)' ? 'local' : 'global';
            if (headings.has(scope) || scope === 'local' && headings.has('global')) { throw unconfirmed(); }
            headings.add(scope); continue;
        }
        if (line === 'Переменных нет.' && !empty && variables.length === 0) { empty = true; continue; }
        const variable = /^- `([^`]+)` = (.*)$/u.exec(line);
        if (!scope || empty || !variable || !validName(variable[1]) || variables.length >= 10_000) { throw unconfirmed(); }
        const key = `${scope}:${variable[1].toLocaleLowerCase()}`;
        if (seen.has(key)) { throw unconfirmed(); }
        seen.add(key); variables.push(Object.freeze({ scope, name: variable[1], representation: variable[2] }));
    }
    if (!variables.length && !empty) { throw unconfirmed(); }
    return Object.freeze(variables);
}
export class VanessaRuntimeVariables {
    constructor(private readonly ports: VanessaVariablePorts) {}
    async list(): Promise<readonly VanessaRuntimeVariable[]> { return parseVanessaVariables(await this.request({ action: 'get' })); }
    async set(scope: VanessaVariableScope, name: string, value: string, expected: string | undefined): Promise<void> {
        this.validate(scope, name);
        if (typeof value !== 'string' || /[\r\n\u0000]/u.test(value) || value.length > 100_000) {
            throw new VanessaVariableControlError('This MCP version supports only single-line string values.');
        }
        await this.checkExpected(scope, name, expected);
        await this.request({ action: 'set', name, value, is_global: scope === 'global' });
        const actual = (await this.list()).find(row => row.scope === scope && row.name.toLocaleLowerCase() === name.toLocaleLowerCase());
        if (!actual || actual.representation !== value) { throw unconfirmed(); }
    }
    async delete(scope: VanessaVariableScope, name: string, expected: string): Promise<void> {
        this.validate(scope, name);
        // .45 ignores is_global for delete and only removes from the local context.
        if (scope === 'global') { throw new VanessaVariableControlError('This Vanessa MCP version cannot delete global variables.'); }
        await this.checkExpected(scope, name, expected);
        await this.request({ action: 'delete', name, is_global: false });
        if ((await this.list()).some(row => row.scope === scope && row.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { throw unconfirmed(); }
    }
    private async checkExpected(scope: VanessaVariableScope, name: string, expected: string | undefined): Promise<void> {
        const current = (await this.list()).find(row => row.scope === scope && row.name.toLocaleLowerCase() === name.toLocaleLowerCase());
        if (current?.representation !== expected) { throw new VanessaVariableControlError('The runtime variable changed. Refresh the variables before editing.'); }
    }
    private validate(scope: VanessaVariableScope, name: string): void {
        if (!['local', 'global'].includes(scope) || !validName(name)) { throw new VanessaVariableControlError('Use a variable name made of letters, digits and underscores, starting with a letter or underscore.'); }
    }
    private async request(args: Readonly<Record<string, unknown>>): Promise<unknown> {
        const check = () => { if (this.ports.isCurrent && !this.ports.isCurrent()) { throw new VanessaVariableControlError('The Vanessa session changed. Refresh the variables.'); } };
        check(); let result: unknown;
        try { result = await this.ports.request(args); } catch { throw unconfirmed(); }
        check(); textReply(result); return result;
    }
}
