import { findObjectKeyByAlias, getVanessaParameterAliases } from './vanessaLaunchJson';
import { parseVanessaClientLaunchSettings } from './vanessaControlClients';
import type { VanessaDebugClient } from './vanessaDebugClients';
import * as path from 'node:path';
import type { VanessaRuntimeSettings } from './vanessaControlSettings';

export type AgentClientTemplate = Pick<VanessaDebugClient, 'name' | 'synonym' | 'username' | 'password' | 'additionalParameters' | 'clientType' | 'computerName'>;

/** The manager retains its previous project when opening another feature. */
export function agentProjectDirectory(launch: string | undefined, basePath: string): string {
    if (launch === undefined) { return basePath; }
    if (Buffer.byteLength(launch) > 4 * 1024 * 1024) { throw new Error('Test launch JSON exceeds the size limit.'); }
    const root: unknown = JSON.parse(launch.replace(/^\uFEFF/u, ''));
    if (!root || typeof root !== 'object' || Array.isArray(root)) { throw new Error('Test launch JSON must be an object.'); }
    const object = root as Record<string, unknown>; const key = findObjectKeyByAlias(object, 'projectpath');
    if (!key) { return basePath; }
    const value = object[key];
    if (typeof value !== 'string' || !value.trim() || /[\u0000\r\n]/u.test(value)) { throw new Error('Test project directory must be a nonempty path.'); }
    return path.resolve(basePath, value);
}

export async function prepareAgentProjectDirectory(settings: Pick<VanessaRuntimeSettings, 'get' | 'set'>, directory: string) {
    const same = (value: string) => value && (process.platform === 'win32'
        ? path.resolve(value).toLocaleLowerCase() === path.resolve(directory).toLocaleLowerCase() : path.resolve(value) === path.resolve(directory));
    const before = await settings.get('КаталогПроекта'); const item = before.item;
    if (!before.ok || before.errors.length || !item || typeof item.current !== 'string') { throw new Error('Could not read the Vanessa project directory.'); }
    if (same(item.current)) { return { previous: item.current, current: item.current, changed: false, revision: before.revision }; }
    if (!item.settable) { throw new Error('This Vanessa session cannot change the test project directory.'); }
    const applied = await settings.set(item.key, directory, before.revision, item.current);
    if (!applied.ok || applied.errors.length) { throw new Error('Vanessa did not apply the test project directory.'); }
    const after = await settings.get(item.key);
    if (!after.ok || after.errors.length || !after.item || !same(after.item.current)) { throw new Error('Vanessa did not confirm the selected test project directory.'); }
    return { previous: item.current, current: after.item.current, changed: true, revision: after.revision };
}
/** Change language switches without changing credentials, paths or quoted /C arguments. */
export function agentLaunchLocale(parameters: string, language?: string, locale?: string): string {
    const code = /^[a-z]{2}(?:[_-][a-z]{2})?$/iu;
    if ((!language && !locale) || [language, locale].some(value => value !== undefined && !code.test(value))) { throw new Error('Choose a valid interface language or locale code.'); }
    const tokenPattern = /(?:[^\s"]+|"[^"]*")+/gu;
    const tokens = [...parameters.matchAll(tokenPattern)];
    if (parameters.replace(tokenPattern, '').trim()) { throw new Error('Inspect unbalanced quotes in the launch parameters.'); }
    const removals: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < tokens.length; index++) {
        const match = /^\/(VL|L)(.*)$/iu.exec(tokens[index][0]);
        if (!match || !(match[1].toUpperCase() === 'L' ? language : locale)) { continue; }
        const start = tokens[index].index!; let end = start + tokens[index][0].length;
        const suffix = match[2].replace(/^"(.*)"$/u, '$1');
        if (!suffix) {
            const next = tokens[++index];
            if (!next || !code.test(next[0].replace(/^"(.*)"$/u, '$1'))) { throw new Error('Inspect the existing language switch value.'); }
            end = next.index! + next[0].length;
        } else if (!code.test(suffix)) { continue; }
        removals.push({ start, end });
    }
    let result = parameters;
    for (const { start, end } of removals.reverse()) { result = result.slice(0, start) + result.slice(end); }
    return [result.trim(), ...(language ? ['/L' + language] : []), ...(locale ? ['/VL' + locale] : [])].filter(Boolean).join(' ');
}
/** Reuse authored test authentication locally; credentials never become an agent tool argument. */
export function agentClientTemplate(text: string): AgentClientTemplate | undefined {
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) { throw new Error('Test launch JSON exceeds the size limit.'); }
    const root: unknown = JSON.parse(text.replace(/^\uFEFF/u, ''));
    const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
    if (!object(root)) { throw new Error('Test launch JSON must be an object.'); }
    const containers: Record<string, unknown>[] = [root];
    const sections = new Set([...getVanessaParameterAliases('RunningScripts'), ...getVanessaParameterAliases('TestClient'), 'MainSettings', 'ОсновныеНастройки'].map(key => key.toLowerCase()));
    for (let index = 0; index < containers.length; index++) {
        if (index >= 32) { throw new Error('Test launch settings are too deeply nested.'); }
        for (const [key, value] of Object.entries(containers[index])) { if (sections.has(key.toLowerCase()) && object(value)) { containers.push(value); } }
    }
    const lists = containers.flatMap(container => { const key = findObjectKeyByAlias(container, 'datatestclients'); return key ? [container[key]] : []; });
    if (!lists.length) { return undefined; }
    if (lists.length !== 1 || !Array.isArray(lists[0]) || lists[0].length !== 1 || !object(lists[0][0])) {
        throw new Error('Select a saved agent client profile for a test with multiple or ambiguous clients.');
    }
    const row = lists[0][0];
    const value = (name: string) => { const key = findObjectKeyByAlias(row, name); const result = key ? row[key] : ''; if (typeof result !== 'string') { throw new Error('Invalid authored test client settings.'); } return result; };
    const type = value('ClientType').toLowerCase();
    if (type && !['thin', 'тонкий', 'thick', 'толстый'].includes(type)) { throw new Error('An isolated file infobase needs a local thin or thick client profile.'); }
    const host = value('ComputerName');
    if (host && !['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase())) { throw new Error('An isolated file infobase needs a local test client profile.'); }
    const name = value('Name'); if (!name.trim()) { throw new Error('The authored test client needs a name.'); }
    return { name, synonym: value('Synonym') || name, ...parseVanessaClientLaunchSettings(value('PathToInfobase'), value('AddItionalParameters')),
        computerName: 'localhost', clientType: ['thick', 'толстый'].includes(type) ? 'Thick' : 'Thin' };
}
