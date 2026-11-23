import { vanessaFormReplyText } from './vanessaControlForms';
import { getVanessaParameterAliases } from './vanessaLaunchJson';

export interface VanessaSetting {
    readonly key: string; readonly path: string; readonly synonym: string; readonly current: string;
    readonly hint?: string; readonly editable?: boolean; readonly settable: boolean; readonly password_mode?: boolean;
    readonly allowed_values?: readonly unknown[];
    readonly type?: string; readonly current_present?: boolean; readonly requires_restart?: boolean;
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
    async apply(parameters: string, basePath: string, revision: number, dryRun: boolean, preserveCiFlags = false): Promise<VanessaSettingsReply> {
        const parsed: unknown = JSON.parse(parameters);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw new Error('VAParams must be a JSON object.'); }
        return parseVanessaSettings(await this.request('manage_va_settings', { action: 'apply', parameters_json: parameters,
            base_path: basePath, expected_revision: revision, dry_run: dryRun, format: 'json',
            ...(preserveCiFlags ? { preserve_ci_flags: true } : {}) }));
    }
}

const sessionKeys = new Set([
    'ExecuteScenarios', 'CloseSystemOnComplete', 'ЗавершитьРаботуСистемыПослеВыполненияВсехСценариев',
    'CloseTestClientAfterScenarioRun', 'logtotext', 'logstepstotext', 'textlogname'
].flatMap(getVanessaParameterAliases).map(key => key.toLowerCase()));

export function prepareVanessaRunSettings(parameters: string): { parameters: string; retained: string[] } {
    const parsed: unknown = JSON.parse(parameters);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw new Error('VAParams must be a JSON object.'); }
    const retained: string[] = [];
    const preserveSessionSettings = (section: object, prefix = '') => {
        for (const [key, value] of Object.entries(section)) {
            if (sessionKeys.has(key.trim().toLowerCase())) {
                delete (section as Record<string, unknown>)[key];
                retained.push(prefix + key);
            } else if (value && typeof value === 'object' && !Array.isArray(value)) {
                preserveSessionSettings(value, `${prefix}${key}.`);
            }
        }
    };
    preserveSessionSettings(parsed);
    return { parameters: JSON.stringify(parsed), retained };
}

export interface VanessaSettingRestore {
    readonly path: string;
    readonly before: string;
    readonly after: string;
}

export function vanessaSettingsToRestore(before: readonly VanessaSetting[], after: readonly VanessaSetting[], changed: readonly unknown[]): VanessaSettingRestore[] {
    const beforeByPath = new Map(before.map(item => [item.path, item]));
    const afterByPath = new Map(after.map(item => [item.path, item]));
    const restore: VanessaSettingRestore[] = [];
    for (const path of new Set(changed)) {
        if (typeof path !== 'string') { continue; }
        const original = beforeByPath.get(path);
        const applied = afterByPath.get(path);
        // VA renders collections for display, so only round-trip confirmed scalar values.
        if (original?.settable && original.current_present && !original.password_mode && !original.requires_restart
            && ['boolean', 'number', 'string', 'path'].includes(original.type ?? '')
            && applied?.current_present && !applied.password_mode
            && typeof original.current === 'string' && typeof applied.current === 'string' && original.current !== applied.current) {
            restore.push({ path, before: original.current, after: applied.current });
        }
    }
    return restore.reverse();
}

export async function restoreVanessaRunSettings(settings: VanessaRuntimeSettings, changes: readonly VanessaSettingRestore[]): Promise<number> {
    const live = await settings.list();
    if (!live.ok || live.errors.length || !live.items) { throw new Error('Unconfirmed Vanessa settings response.'); }
    const currentByPath = new Map(live.items.map(item => [item.path, item]));
    let revision = live.revision;
    let restored = 0;
    for (const change of changes) {
        const current = currentByPath.get(change.path);
        if (!current?.current_present || current.password_mode) { continue; }
        if (current.current === change.before) { restored++; continue; }
        if (!current.settable || current.current !== change.after) { continue; }
        const result = await settings.set(change.path, change.before, revision, change.after);
        revision = result.revision;
        if (result.ok && !result.errors.length && result.applied.includes(change.path)) { restored++; }
    }
    return restored;
}
