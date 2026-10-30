import fs from 'node:fs/promises';
import path from 'node:path';
import { collectTreeWithConcurrencyLimit, mapWithConcurrencyLimit } from './boundedConcurrency';

export interface InfobaseTemplate { name: string; version: string; kind: 'configuration' | 'demo'; filePath: string; manifestPath: string }
export function parseTemplateLocations(source: string): string[] {
    return [...source.matchAll(/^\s*ConfigurationTemplatesLocation\s*=\s*(.+?)\s*$/gimu)]
        .map(match => match[1].replace(/^"(.*)"$/u, '$1').trim()).filter(Boolean);
}
export function decodeTemplateText(buffer: Buffer): string {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) { return buffer.toString('utf16le').replace(/^\uFEFF/u, ''); }
    const text = buffer.toString('utf8').replace(/^\uFEFF/u, '');
    return text.includes('\uFFFD') ? new TextDecoder('windows-1251').decode(buffer) : text;
}
export function templateCreationArguments(connection: string, templateFile?: string): string[] {
    return ['CREATEINFOBASE', connection, ...(templateFile ? ['/UseTemplate', templateFile] : [])];
}

/** Standard 1cv8.mft entries; only actual .cf/.dt files within the installed version are selectable. */
export async function discoverInfobaseTemplates(roots: readonly string[]): Promise<InfobaseTemplate[]> {
    const manifests = (await Promise.all([...new Set(roots.map(root => path.resolve(root)))].map(root =>
        collectTreeWithConcurrencyLimit({ directory: root, depth: 0 }, 16, async node => {
            const entries = await fs.readdir(node.directory, { withFileTypes: true }).catch(() => []);
            return { children: node.depth < 10 ? entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => ({ directory: path.join(node.directory, entry.name), depth: node.depth + 1 })) : [],
                values: entries.filter(entry => entry.isFile() && entry.name.toLowerCase() === '1cv8.mft').map(entry => path.join(node.directory, entry.name)) };
        })))).flat();
    const lists = await mapWithConcurrencyLimit(manifests, 16, async manifestPath => {
        const text = decodeTemplateText(await fs.readFile(manifestPath));
        const header: Record<string, string> = {}; const variants: Array<Record<string, string>> = []; let current = header;
        for (const line of text.split(/\r\n|\n|\r/u)) {
            if (/^\s*\[.+\]\s*$/u.test(line)) { current = {}; variants.push(current); continue; }
            const field = /^\s*([^;#=\s]+)\s*=\s*(.*?)\s*$/u.exec(line);
            if (field) { current[field[1].toLowerCase()] = field[2].replace(/^"(.*)"$/u, '$1'); }
        }
        const directory = path.dirname(manifestPath); const realDirectory = await fs.realpath(directory); const results: InfobaseTemplate[] = [];
        for (const item of variants) {
            const source = item.source ?? ''; const extension = path.extname(source).toLowerCase();
            if (!['.cf', '.dt'].includes(extension) || path.win32.isAbsolute(source) || path.isAbsolute(source)) { continue; }
            const filePath = path.resolve(directory, source.replace(/\\/gu, '/')); const relative = path.relative(directory, filePath);
            if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { continue; }
            const stat = await fs.lstat(filePath).catch(() => undefined);
            if (!stat?.isFile()) { continue; }
            const realFile = await fs.realpath(filePath).catch(() => undefined);
            if (!realFile) { continue; }
            const realRelative = path.relative(realDirectory, realFile);
            if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) { continue; }
            results.push({ name: item.catalog || header.name || path.basename(directory), version: header.version || '',
                kind: extension === '.dt' ? 'demo' : 'configuration', filePath, manifestPath });
        }
        return results;
    });
    return [...new Map(lists.flat().map(item => [process.platform === 'win32' ? item.filePath.toLowerCase() : item.filePath, item])).values()]
        .sort((left, right) => left.name.localeCompare(right.name) || right.version.localeCompare(left.version, undefined, { numeric: true }));
}
