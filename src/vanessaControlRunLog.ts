import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { localOneCLaunchParameters, type LocalOneCLaunchParameters } from './vanessaControlDiscovery';
import { findObjectKeyByAlias } from './vanessaLaunchJson';

/** Recover a KOT launch after reconnect/reload from this endpoint's actual 1C process. */
export async function findManagedVanessaRunLog(endpoint: string, runtimeRoot: string,
    lookup: (endpoint: string) => Promise<LocalOneCLaunchParameters | undefined> = localOneCLaunchParameters): Promise<string | undefined> {
    try {
        const launch = await lookup(endpoint); if (!launch) { return undefined; }
        const inside = (file: string, root: string) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
        if (!path.isAbsolute(launch.parametersPath) || path.basename(launch.parametersPath) !== 'VAParams.json'
            || !inside(launch.parametersPath, path.join(runtimeRoot, 'debug-params'))) { return undefined; }
        const stat = await fs.lstat(launch.parametersPath);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || stat.mtimeMs > launch.startedAt) { return undefined; }
        const json: unknown = JSON.parse(await fs.readFile(launch.parametersPath, 'utf8'));
        if (!json || typeof json !== 'object' || Array.isArray(json)) { return undefined; }
        const value = (key: string): unknown => { const actual = findObjectKeyByAlias(json, key); return actual ? (json as Record<string, unknown>)[actual] : undefined; };
        const enabled = (key: string) => /^(?:true|истина)$/iu.test(String(value(key)));
        const log = value('textlogname');
        if (!enabled('logtotext') || !enabled('logstepstotext') || typeof log !== 'string' || !path.isAbsolute(log) || !inside(log, runtimeRoot)) { return undefined; }
        const current = await fs.lstat(launch.parametersPath);
        return current.mtimeMs === stat.mtimeMs && current.size === stat.size ? path.normalize(log) : undefined;
    } catch { return undefined; }
}
