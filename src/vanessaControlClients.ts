import { applyVanessaManualDebugOverlay, type VanessaDebugClient } from './vanessaDebugClients';
import type { JsonValue } from './vanessaLaunchJson';

export type VanessaClientOperation = 'list' | 'add' | 'edit' | 'connect' | 'disconnect' | 'close';
export interface VanessaClientProfile {
    readonly name: string;
    readonly synonym: string;
    readonly connection: string;
    readonly additionalParameters: string;
    readonly clientType: string;
    readonly computerName: string;
    readonly windowHandle: string;
    readonly pid?: number;
    readonly connected: boolean;
}
export interface PreparedVanessaClientProfile {
    readonly fields: Readonly<Record<string, string>>;
    readonly unsupportedFields: readonly ['port'];
}
export interface VanessaRuntimeClientPorts {
    request(operation: VanessaClientOperation, fields?: Readonly<Record<string, string>>): Promise<unknown>;
    isCurrent?(): boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export class VanessaClientControlError extends Error {}
function clientError(): Error { return new VanessaClientControlError('The Vanessa client operation was not confirmed.'); }

function formattedInteger(value: string): number | undefined {
    if (!/^(?:\d+|[1-9]\d{0,2}([, \u00a0\u202f])\d{3}(?:\1\d{3})*)$/u.test(value)) { return undefined; }
    const number = Number(value.replace(/[, \u00a0\u202f]/gu, ''));
    return Number.isSafeInteger(number) ? number : undefined;
}

function confirmsClosedClient(reply: unknown, name: string): boolean {
    const content = record(reply)?.content;
    if (!Array.isArray(content) || content.length !== 1) { return false; }
    const block = record(content[0]);
    return block?.type === 'text' && typeof block.text === 'string' && block.text.replace(/\r\n/gu, '\n').trim() ===
        `# Клиент тестирования закрыт\n\n- Профиль: ${name}\n- Статус: закрыт успешно\n\n## Следующие шаги\n- Используйте \`manage_test_client\` с \`action: connect\` для повторного подключения`;
}

/** Actual .45 formatter is Markdown and does not escape pipes/newlines in cell values. */
export function parseVanessaClientProfiles(reply: unknown): readonly VanessaClientProfile[] {
    const invalid = () => new VanessaClientControlError('Unknown Vanessa client profile list. Refresh the session before retrying.');
    const result = record(reply);
    if (result?.isError || !Array.isArray(result?.content) || result.content.length !== 1) { throw invalid(); }
    const content = record(result.content[0]);
    if (content?.type !== 'text' || typeof content.text !== 'string' || content.text.length > 1_000_000) { throw invalid(); }
    const text = content.text.replace(/\r\n/gu, '\n').trim();
    if (text === '# Список профилей клиентов тестирования\n\nПрофили не настроены. Добавьте профиль на вкладке \'Клиенты тестирования\' в настройках VA.') { return []; }
    const sections = text.split(/\n(?=## Профиль: )/u);
    const count = /^# Список профилей клиентов тестирования\n\nНайдено профилей: ([^\n]+)\s*$/u.exec(sections.shift() ?? '');
    if (!count || formattedInteger(count[1].trim()) !== sections.length || !sections.length || sections.length > 1_000) { throw invalid(); }
    const keys = ['Имя', 'Синоним', 'Строка подключения', 'Дополнительные параметры', 'Тип клиента', 'Имя компьютера', 'Дескриптор окна', 'PID', 'Статус'];
    const identities = new Map<string, number>();
    return Object.freeze(sections.map((section, index) => {
        const lines = section.trim().split('\n').filter(line => line.trim());
        const heading = /^## Профиль: (.+)$/u.exec(lines.shift() ?? '')?.[1];
        if (!heading || lines.shift() !== '| Свойство | Значение |' || lines.shift() !== '|----------|----------|' || lines.length !== keys.length) { throw invalid(); }
        const values = lines.map((line, fieldIndex) => {
            const cells = /^\| ([^|]+) \| ?([^|]*?) ?\|$/u.exec(line);
            if (!cells || cells[1] !== keys[fieldIndex]) { throw invalid(); }
            return cells[2];
        });
        const pid = values[7] ? formattedInteger(values[7]) : undefined;
        if (heading !== values[0] || values[7] && pid === undefined || !['✅ подключен', '❌ не подключен'].includes(values[8])) { throw invalid(); }
        for (const name of [values[0], values[1]].filter(Boolean)) {
            const identity = name.toLocaleLowerCase();
            if (identities.has(identity) && identities.get(identity) !== index) { throw invalid(); }
            identities.set(identity, index);
        }
        return Object.freeze({ name: values[0], synonym: values[1], connection: values[2], additionalParameters: values[3],
            clientType: values[4], computerName: values[5], windowHandle: values[6], pid, connected: values[8] === '✅ подключен' });
    }));
}

/** Reuse the exact Debug overlay so authentication never enters the infobase path. */
export function prepareVanessaClientProfile(client: VanessaDebugClient): PreparedVanessaClientProfile {
    const overlay = applyVanessaManualDebugOverlay({}, { mode: 'clients', clients: [client] });
    const section = overlay.TestClient as Record<string, JsonValue>;
    const row = (section.datatestclients as Array<Record<string, JsonValue>>)[0];
    const types: Record<string, string> = { Thin: 'Тонкий', Thick: 'Толстый', Тонкий: 'Тонкий', Толстый: 'Толстый' };
    const fields = { name: String(row.Name), synonym: String(row.Synonym), infobase_path: String(row.PathToInfobase),
        additional_parameters: String(row.AddItionalParameters), client_type: types[String(row.ClientType)], computer_name: String(row.ComputerName) };
    if (!fields.client_type || Object.values(fields).some(value => /[\r\n|]/u.test(value) || value !== value.trim())) {
        throw new VanessaClientControlError('These client fields cannot be verified through the Vanessa MCP profile format. Use the saved set for a managed launch.');
    }
    return Object.freeze({ fields: Object.freeze(fields), unsupportedFields: Object.freeze(['port'] as const) });
}

/** Runs inside the shared session's exclusive operation; no credentials enter its public snapshot. */
export class VanessaRuntimeClients {
    constructor(private readonly ports: VanessaRuntimeClientPorts) {}

    async list(): Promise<readonly VanessaClientProfile[]> { return parseVanessaClientProfiles(await this.request('list')); }

    async apply(client: VanessaDebugClient, acknowledgeUnsupportedPort: boolean): Promise<{ applied: true; unsupportedFields: readonly ['port'] }> {
        const prepared = prepareVanessaClientProfile(client);
        if (!acknowledgeUnsupportedPort) { throw new VanessaClientControlError('Vanessa MCP cannot set or verify the saved client port. Acknowledge applying only supported fields, or use a managed launch.'); }
        const profiles = await this.list();
        const existing = profiles.find(profile => profile.name.toLocaleLowerCase() === client.name.toLocaleLowerCase());
        if (existing?.connected) { throw new VanessaClientControlError('Disconnect this client before changing its connection.'); }
        if (profiles.some(profile => profile !== existing && [profile.name, profile.synonym].filter(Boolean).some(name =>
            [client.name, client.synonym].filter(Boolean).some(value => value.toLocaleLowerCase() === name.toLocaleLowerCase())))) {
            throw new VanessaClientControlError('Another Vanessa client already uses this name or synonym.');
        }
        await this.request(existing ? 'edit' : 'add', prepared.fields);
        const actual = (await this.list()).find(profile => profile.name === client.name);
        if (!actual || actual.synonym !== prepared.fields.synonym || actual.connection !== prepared.fields.infobase_path ||
            actual.additionalParameters !== prepared.fields.additional_parameters || actual.clientType !== prepared.fields.client_type ||
            actual.computerName !== prepared.fields.computer_name) { throw clientError(); }
        return { applied: true, unsupportedFields: prepared.unsupportedFields };
    }

    async connect(name: string): Promise<void> { await this.change('connect', name); }
    async disconnect(name: string): Promise<void> { await this.change('disconnect', name); }
    async close(name: string): Promise<void> { await this.change('close', name); }

    private async change(operation: 'connect' | 'disconnect' | 'close', name: string): Promise<void> {
        const profiles = await this.list(); const selected = profiles.find(profile => profile.name === name);
        if (!selected) { throw new VanessaClientControlError('This Vanessa client profile no longer exists. Refresh the list.'); }
        // .45 disconnect ignores profileName and disconnects the CURRENT client only.
        if (operation === 'disconnect' && (!selected.connected || profiles.filter(profile => profile.connected).length !== 1)) {
            throw new VanessaClientControlError('The current Vanessa client is ambiguous. Select or disconnect it in Vanessa.');
        }
        const reply = await this.request(operation, { name });
        // .45 waits for the OS process to exit, but leaves the previous PID in the table.
        if (operation === 'close' && !confirmsClosedClient(reply, name)) { throw clientError(); }
        const actual = (await this.list()).find(profile => profile.name === name);
        if (!actual || actual.connected !== (operation === 'connect')) { throw clientError(); }
    }

    private async request(operation: VanessaClientOperation, fields?: Readonly<Record<string, string>>): Promise<unknown> {
        const assertCurrent = () => { if (this.ports.isCurrent && !this.ports.isCurrent()) { throw new VanessaClientControlError('The Vanessa session changed. Refresh the client list.'); } };
        assertCurrent();
        let result: unknown;
        try { result = await this.ports.request(operation, fields); }
        catch { throw clientError(); }
        assertCurrent();
        if (record(result)?.isError) { throw clientError(); }
        return result;
    }
}
