import path from 'node:path';
import { VANESSA_PARAMETER_CATALOG } from './vanessaParameterCatalog.generated';
import { getVanessaParameterAliases } from './vanessaLaunchJson';
import { normalizeBuildParameterKey } from './compilerBuildParameters';

export interface ParameterPathField {
    kind: 'file' | 'folder' | 'choice';
    multiple?: 'pipe' | 'json';
    relative?: boolean;
    save?: boolean;
}

const buildFolders = new Set([
    'scenariofolder', 'testfolder', 'processfolder', 'featurefolder', 'vanessafolder', 'vanessapath', 'vanessadir',
    'launchdbfolder', 'testclientdbpath', 'junitpath', 'junitfolder', 'errorfolder', 'bddlogfolder',
    'screenshotsfolder', 'screenshotspath', 'allurepath', 'allurefolder', 'cucumberfolder', 'spprreportfolder'
]);
const buildFiles = new Set(['modeldbsettings', 'compilefile', 'junitfile', 'logfile', 'resultfile', 'scenariologfile', 'scenariooutfile']);

export function getBuildParameterPathField(key: string, value = ''): ParameterPathField | undefined {
    const normalized = normalizeBuildParameterKey(key);
    if (['launchdbfolder', 'testclientdbpath'].includes(normalized) && /(?:file|srvr)\s*=/iu.test(value)) { return; }
    if (buildFolders.has(normalized)) { return { kind: 'folder', relative: true }; }
    if (buildFiles.has(normalized)) { return { kind: 'file', relative: true, save: normalized !== 'modeldbsettings' }; }
    if (['libraries', 'vanessalibraries'].includes(normalized)) { return { kind: 'folder', multiple: 'pipe', relative: true }; }
    return undefined;
}

export function getVanessaParameterPathField(key: string, valueKind?: string): ParameterPathField | undefined {
    if (valueKind && !['string', 'array', 'unknown'].includes(valueKind)) { return; }
    const leaf = key.split('.').at(-1)!.replace(/^(?:ЗаписьВидео|ДымовыеТесты)/u, '');
    if (leaf === 'КаталогиБиблиотек') { return { kind: 'folder', multiple: 'json' }; }
    if (/^(?:Каталог|ИмяКаталога|КэшФайлов)/u.test(leaf)) { return { kind: 'folder' }; }
    if (/^(?:ПутьК|ИмяФайла|Файл)/u.test(leaf)) { return { kind: 'file', save: /^ИмяФайла|^ПутьКФайлуДляВыгрузки/u.test(leaf) }; }
    return undefined;
}

/** Globals have no declared type: let the user choose whether a string holds a file or folder. */
export function getParameterPathField(section: string, key: string, value: string): ParameterPathField | undefined {
    if (section === 'build') { return getBuildParameterPathField(key, value); }
    if (section === 'globalVars') { return { kind: 'choice' }; }
    if (section !== 'additional') { return; }
    const normalized = key.trim().replace(/^\//u, '').replace(/~1/gu, '/').replace(/~0/gu, '~').replace(/\//gu, '.').toLowerCase();
    const entry = VANESSA_PARAMETER_CATALOG.find(item => [item.key, ...item.aliases, ...getVanessaParameterAliases(item.key),
        ...getVanessaParameterAliases(item.key.split('.').at(-1)!)].some(alias => alias.toLowerCase() === normalized));
    return getVanessaParameterPathField(entry?.key ?? key, entry?.valueKind ?? 'string');
}

/** Only compiler fields have a guaranteed project-relative resolver in every launch flow. */
export function formatPickedParameterPath(selected: string, root: string | null, field: ParameterPathField): string {
    if (!root || !field.relative) { return selected; }
    const paths = /^(?:[a-z]:[\\/]|[\\/]{2})/iu.test(root) ? path.win32 : path.posix;
    const relative = paths.relative(root, selected);
    return paths.isAbsolute(relative) ? selected : (relative || '.').replace(/\\/gu, '/');
}

export function mergePickedParameterPaths(value: string, selected: readonly string[], field: ParameterPathField): string {
    if (!field.multiple) { return selected[0] ?? value; }
    const previous: unknown = field.multiple === 'json' ? JSON.parse(value || '[]') : value.split('|').map(item => item.trim()).filter(Boolean);
    if (!Array.isArray(previous) || !previous.every(item => typeof item === 'string')) { throw new Error('Expected a list of paths.'); }
    const merged = [...new Set([...previous, ...selected])];
    return field.multiple === 'json' ? JSON.stringify(merged) : merged.join('|');
}
