import { applyVanessaManualDebugOverlay, getVanessaDebugClientAuthentication, type VanessaDebugClient } from './vanessaDebugClients';
import { normalizeInfobaseConnectionIdentity } from './oneCInfobaseConnection';
import { redactVanessaDiagnosticText } from './vanessaControlRedaction';
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
    readonly port?: number;
}
export interface PreparedVanessaClientProfile {
    readonly fields: Readonly<Record<string, string | number> & { name: string; synonym: string; infobase_path: string; additional_parameters: string; client_type: string; computer_name: string }>;
    readonly unsupportedFields: readonly 'port'[];
}
export interface VanessaRuntimeClientPorts {
    readonly supportsPort?: boolean;
    request(operation: VanessaClientOperation, fields?: Readonly<Record<string, string | number>>): Promise<unknown>;
    isCurrent?(): boolean;
}

export function sameVanessaClientProfile(left: VanessaClientProfile, right: VanessaClientProfile): boolean {
    const fields = (value: VanessaClientProfile) => [value.name, value.synonym, value.connection, value.additionalParameters, value.clientType, value.computerName, value.port];
    return JSON.stringify(fields(left)) === JSON.stringify(fields(right));
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export class VanessaClientControlError extends Error {
    constructor(message: string, readonly details?: string) { super(message); }
}
export function formatVanessaClientError(error: { message: string; details?: string }, translate: (message: string) => string): string {
    return translate(error.message) + (error.details ? '\n\n' + error.details : '');
}
function clientError(reply?: unknown, secrets: readonly string[] = [], message = 'The Vanessa client operation was not confirmed.'): VanessaClientControlError {
    const content = record(reply)?.content;
    let details: string | undefined;
    if (Array.isArray(content) && content.length <= 8 && content.every(block => record(block)?.type === 'text' && typeof record(block)?.text === 'string')) {
        let text = content.map(block => record(block)!.text as string).join('\n');
        if (text.length <= 64_000) {
            try {
                const data = record(JSON.parse(text)); const error = record(data?.error);
                text = typeof error?.message === 'string' ? error.message : typeof data?.message === 'string' ? data.message : text;
            } catch { /* Text replies are the legacy error format. */ }
            for (const secret of secrets.filter(Boolean)) { text = text.replaceAll(secret, '[redacted]'); }
            details = redactVanessaDiagnosticText(text).trim().slice(0, 8_000) || undefined;
        }
    }
    return new VanessaClientControlError(message, details);
}

/** 1C accepts both /N"User" and /N "User"; quoted arguments may themselves contain launch-like text. */
export function parseVanessaClientLaunchSettings(connection: string, parameters: string) {
    const authentication = getVanessaDebugClientAuthentication({ infobase: connection, username: '', password: '' });
    const tokens = parameters.match(/(?:[^\s"]+|"(?:[^"]|"")*")+/gu) ?? [];
    const other: string[] = [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        const attached = /^\/([NP])(?:"((?:[^"]|"")*)"|([^\s"]+))$/iu.exec(token);
        const separate = /^\/([NP])$/iu.exec(token);
        let key = attached?.[1]; let value = attached?.[2]?.replace(/""/gu, '"') ?? attached?.[3];
        if (separate && tokens[index + 1] !== undefined && !tokens[index + 1].startsWith('/')) {
            key = separate[1]; const argument = tokens[++index];
            value = argument.startsWith('"') && argument.endsWith('"') ? argument.slice(1, -1).replace(/""/gu, '"') : argument;
        }
        if (!key || value === undefined) { other.push(token); continue; }
        if (key.toUpperCase() === 'N') { authentication.username = value; } else { authentication.password = value; }
    }
    return { username: authentication.username ?? '', password: authentication.password ?? '', additionalParameters: other.join(' ') };
}

export function matchesVanessaClientSettings(client: VanessaDebugClient, row: VanessaClientProfile, comparePort = row.port !== undefined): boolean {
    const fields = prepareVanessaClientProfile(client).fields;
    const expected = parseVanessaClientLaunchSettings(fields.infobase_path, fields.additional_parameters);
    const actual = parseVanessaClientLaunchSettings(row.connection, row.additionalParameters);
    return normalizeInfobaseConnectionIdentity(row.connection) === normalizeInfobaseConnectionIdentity(client.infobase) &&
        row.clientType === fields.client_type && row.computerName.trim().toLocaleLowerCase() === fields.computer_name.trim().toLocaleLowerCase() &&
        actual.username === expected.username && actual.password === expected.password && actual.additionalParameters === expected.additionalParameters &&
        row.synonym === fields.synonym && (!comparePort || row.port === client.port);
}

function formattedInteger(value: string): number | undefined {
    if (!/^(?:\d+|[1-9]\d{0,2}([, \u00a0\u202f])\d{3}(?:\1\d{3})*)$/u.test(value)) { return undefined; }
    const number = Number(value.replace(/[, \u00a0\u202f]/gu, ''));
    return Number.isSafeInteger(number) ? number : undefined;
}

function confirmsClosedClient(reply: unknown, name: string): boolean {
    if (record(reply)?.isError) { return false; }
    const content = record(reply)?.content;
    if (!Array.isArray(content) || content.length !== 1) { return false; }
    const block = record(content[0]);
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 1_000_000) { return false; }
    const section = block.text.replace(/\r\n/gu, '\n').trim().split('\n## ')[0];
    const profiles = [...section.matchAll(/^- Профиль: (.+)$/gmu)];
    const statuses = [...section.matchAll(/^- Статус: (.+)$/gmu)];
    return section.startsWith('# Клиент тестирования закрыт\n') && profiles.length === 1 && profiles[0][1] === name &&
        statuses.length === 1 && statuses[0][1] === 'закрыт успешно';
}

/** Read the .45/.47 Markdown table by field identity; extra metadata and prose are not data. */
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
        const lines = section.trim().split('\n').map(line => line.trim()).filter(Boolean);
        const heading = /^## Профиль: (.+)$/u.exec(lines.shift() ?? '')?.[1];
        if (!heading || !/^\|\s*Свойство\s*\|\s*Значение\s*\|$/u.test(lines.shift() ?? '') ||
            !/^\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|$/u.test(lines.shift() ?? '')) { throw invalid(); }
        const fields = new Map<string, string>(); let footer = false;
        for (const line of lines) {
            if (!line.startsWith('|')) { footer = true; continue; }
            const cells = /^\| ([^|]+) \| ?([^|]*?) ?\|$/u.exec(line);
            if (footer || !cells || fields.size >= 128 || fields.has(cells[1].trim())) { throw invalid(); }
            fields.set(cells[1].trim(), cells[2].trim());
        }
        if (keys.some(key => !fields.has(key))) { throw invalid(); }
        const values = keys.map(key => fields.get(key)!);
        const portText = fields.get('Порт');
        const port = portText === undefined ? undefined : formattedInteger(portText);
        if (portText !== undefined && (port === undefined || port > 65535)) { throw invalid(); }
        const pid = values[7] ? formattedInteger(values[7]) : undefined;
        const status = values[8].replace(/ё/gu, 'е');
        if (heading !== values[0] || values[7] && pid === undefined || !['✅ подключен', '❌ не подключен'].includes(status)) { throw invalid(); }
        for (const name of [values[0], values[1]].filter(Boolean)) {
            const identity = name.toLocaleLowerCase();
            if (identities.has(identity) && identities.get(identity) !== index) { throw invalid(); }
            identities.set(identity, index);
        }
        return Object.freeze({ name: values[0], synonym: values[1], connection: values[2], additionalParameters: values[3],
            clientType: values[4], computerName: values[5], windowHandle: values[6], pid, connected: status === '✅ подключен', ...(port !== undefined ? { port } : {}) });
    }));
}

/** Reuse the exact Debug overlay so authentication never enters the infobase path. */
export function prepareVanessaClientProfile(client: VanessaDebugClient, supportsPort = false): PreparedVanessaClientProfile {
    const overlay = applyVanessaManualDebugOverlay({}, { mode: 'clients', clients: [client] });
    const section = overlay.TestClient as Record<string, JsonValue>;
    const row = (section.datatestclients as Array<Record<string, JsonValue>>)[0];
    const types: Record<string, string> = { Thin: 'Тонкий', Thick: 'Толстый', Тонкий: 'Тонкий', Толстый: 'Толстый' };
    const fields = { name: String(row.Name), synonym: String(row.Synonym), infobase_path: String(row.PathToInfobase),
        additional_parameters: String(row.AddItionalParameters), client_type: types[String(row.ClientType)], computer_name: String(row.ComputerName) };
    if (!fields.client_type || Object.values(fields).some(value => /[\r\n|]/u.test(value) || value !== value.trim())) {
        throw new VanessaClientControlError('These client fields cannot be verified through the Vanessa MCP profile format. Use the saved set for a managed launch.');
    }
    return Object.freeze({ fields: Object.freeze({ ...fields, ...(supportsPort ? { port: client.port } : {}) }), unsupportedFields: Object.freeze(supportsPort ? [] : ['port'] as const) });
}

/** Runs inside the shared session's exclusive operation; no credentials enter its public snapshot. */
export class VanessaRuntimeClients {
    constructor(private readonly ports: VanessaRuntimeClientPorts) {}

    async list(): Promise<readonly VanessaClientProfile[]> { return parseVanessaClientProfiles(await this.request('list')); }

    async apply(client: VanessaDebugClient, acknowledgeUnsupportedPort: boolean, expected?: VanessaClientProfile | null): Promise<{ applied: true; unsupportedFields: readonly 'port'[] }> {
        const prepared = prepareVanessaClientProfile(client, this.ports.supportsPort);
        if (prepared.unsupportedFields.length && !acknowledgeUnsupportedPort) { throw new VanessaClientControlError('Vanessa MCP cannot set or verify the saved client port. Acknowledge applying only supported fields, or use a managed launch.'); }
        const profiles = await this.list();
        const existing = profiles.find(profile => profile.name.toLocaleLowerCase() === client.name.toLocaleLowerCase());
        if (expected === null && existing) { throw new VanessaClientControlError('A Vanessa profile with this name appeared. Refresh the client list.'); }
        if (expected && (!existing || !sameVanessaClientProfile(existing, expected))) { throw new VanessaClientControlError('The Vanessa client profile changed. Refresh the client list.'); }
        if (existing?.connected) { throw new VanessaClientControlError('Disconnect this client before changing its connection.'); }
        if (profiles.some(profile => profile !== existing && [profile.name, profile.synonym].filter(Boolean).some(name =>
            [client.name, client.synonym].filter(Boolean).some(value => value.toLocaleLowerCase() === name.toLocaleLowerCase())))) {
            throw new VanessaClientControlError('Another Vanessa client already uses this name or synonym.');
        }
        await this.request(existing ? 'edit' : 'add', prepared.fields);
        const actual = (await this.list()).find(profile => profile.name === client.name);
        if (!actual || !matchesVanessaClientSettings(client, actual, !!this.ports.supportsPort)) { throw clientError(); }
        return { applied: true, unsupportedFields: prepared.unsupportedFields };
    }

    async connect(name: string, expected?: VanessaClientProfile): Promise<void> { await this.change('connect', name, expected); }
    async disconnect(name: string, expected?: VanessaClientProfile): Promise<void> { await this.change('disconnect', name, expected); }
    async close(name: string): Promise<void> { await this.change('close', name); }

    private async change(operation: 'connect' | 'disconnect' | 'close', name: string, expected?: VanessaClientProfile): Promise<void> {
        const profiles = await this.list(); const selected = profiles.find(profile => profile.name === name);
        if (!selected) { throw new VanessaClientControlError('This Vanessa client profile no longer exists. Refresh the list.'); }
        if (expected && !sameVanessaClientProfile(selected, expected)) { throw new VanessaClientControlError('The Vanessa client profile changed. Refresh the client list.'); }
        // .45 disconnect ignores profileName and disconnects the CURRENT client only.
        if (operation === 'disconnect' && (!selected.connected || profiles.filter(profile => profile.connected).length !== 1)) {
            throw new VanessaClientControlError('The current Vanessa client is ambiguous. Select or disconnect it in Vanessa.');
        }
        const secrets = [parseVanessaClientLaunchSettings(selected.connection, selected.additionalParameters).password];
        const reply = await this.request(operation, { name }, secrets);
        // .45 waits for the OS process to exit, but leaves the previous PID in the table.
        if (operation === 'close' && !confirmsClosedClient(reply, name)) { throw clientError(reply, secrets); }
        const actual = (await this.list()).find(profile => profile.name === name);
        if (!actual || actual.connected !== (operation === 'connect')) {
            throw clientError(reply, secrets, actual && operation === 'connect' ? 'Vanessa did not connect the test client. Check messages in the Vanessa window for the underlying reason.' : undefined);
        }
    }

    private async request(operation: VanessaClientOperation, fields?: Readonly<Record<string, string | number>>, secrets: readonly string[] = []): Promise<unknown> {
        const assertCurrent = () => { if (this.ports.isCurrent && !this.ports.isCurrent()) { throw new VanessaClientControlError('The Vanessa session changed. Refresh the client list.'); } };
        assertCurrent();
        let result: unknown;
        try { result = await this.ports.request(operation, fields); }
        catch { throw clientError(); }
        assertCurrent();
        if (record(result)?.isError) {
            throw clientError(result, [...secrets, parseVanessaClientLaunchSettings(String(fields?.infobase_path ?? ''), String(fields?.additional_parameters ?? '')).password]);
        }
        return result;
    }
}
