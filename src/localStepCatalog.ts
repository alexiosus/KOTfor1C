import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseStaticBslStepRegistrations, type StaticBslStepRegistration } from './bslStepSourceParser';
import { enrichStepCatalogCategories } from './stepCatalogCategories';
import { parseVanessaStepTemplateXml } from './stepCatalogTemplateXml';
import { executableStepDefinitions, parseStepCatalogDefinitions, sha256Hex, sortStepCatalogDefinitions, type BuiltInStepDefinition, type ResolvedStepCatalog } from './stepCatalog';

export interface LocalStepCatalog {
    readonly schemaVersion: 1;
    readonly vanessaVersion: string;
    readonly generatedAt: string;
    readonly source: { readonly kind: 'local'; readonly sha256: string; readonly generatorVersion?: number };
    readonly steps: readonly BuiltInStepDefinition[];
}

export const LOCAL_STEP_CATALOG_GENERATOR_VERSION = 2;

export interface LocalStepCatalogProgress {
    readonly phase: 'preparing' | 'exporting' | 'ready' | 'error';
    readonly completed?: number;
    readonly total?: number;
    readonly stepCount?: number;
    readonly error?: string;
}

export function localStepCatalogNeedsUpgrade(text: string): boolean {
    try {
        const catalog = JSON.parse(text) as LocalStepCatalog;
        return catalog.schemaVersion === 1 && catalog.source?.kind === 'local'
            && (catalog.source.generatorVersion ?? 1) < LOCAL_STEP_CATALOG_GENERATOR_VERSION;
    } catch { return false; }
}

/** Compiled distributions keep step registrations inside EPF modules. */
export async function findLocalStepCategoryEpfs(root: string): Promise<readonly string[]> {
    const directories = [root]; const files: string[] = [];
    while (directories.length) {
        const directory = directories.pop()!;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory() && !['.git', 'node_modules', '.kot'].includes(entry.name)) { directories.push(file); }
            else if (entry.isFile() && /\.(?:epf|erf)$/iu.test(entry.name)) {
                const source = path.join(directory, path.parse(entry.name).name);
                if (!await stat(source).then(value => value.isDirectory(), () => false)) { files.push(file); }
            }
        }
    }
    return files.sort((left, right) => left.localeCompare(right));
}

export function resolveLocalStepCatalog(text: string, expectedVersion?: string): ResolvedStepCatalog {
    const raw = JSON.parse(text) as LocalStepCatalog;
    if (raw?.schemaVersion !== 1 || raw.source?.kind !== 'local' || !/^[a-f0-9]{64}$/u.test(raw.source.sha256) ||
        !/^\d+\.\d+\.\d+\.\d+$/u.test(raw.vanessaVersion) || !Number.isFinite(Date.parse(raw.generatedAt)) ||
        expectedVersion && raw.vanessaVersion !== expectedVersion) { throw new Error('Invalid or incompatible local Vanessa step catalog.'); }
    return { identity: `local:${sha256Hex(text)}`, catalogVersion: raw.vanessaVersion, requestedVersion: expectedVersion,
        source: 'local', steps: executableStepDefinitions(parseStepCatalogDefinitions(raw.steps)) };
}

/** Reads the installed sources only. No 1C, Git checkout or network is required. */
export async function generateLocalStepCatalog(root: string, version: string, signal?: AbortSignal, templatePath?: string, sourceRoots: readonly string[] = []): Promise<LocalStepCatalog> {
    if (!/^\d+\.\d+\.\d+\.\d+$/u.test(version)) { throw new Error('Enter a four-component Vanessa version.'); }
    signal?.throwIfAborted();
    const template = await readFile(templatePath ?? path.join(root, 'locales', 'Steps', 'Templates', 'en', 'Ext', 'Template.xml'), 'utf8');
    const parsed = parseVanessaStepTemplateXml(template);
    const hash = createHash('sha256').update(template);
    const registrations: (StaticBslStepRegistration & { sourceUri: string })[] = [];
    const directories = [root, ...sourceRoots].map((sourceRoot, index) => ({ directory: sourceRoot, sourceRoot, index }));
    while (directories.length) {
        signal?.throwIfAborted();
        const { directory, sourceRoot, index } = directories.pop()!;
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory() && !['.git', 'node_modules', '.kot'].includes(entry.name)) { directories.push({ directory: file, sourceRoot, index }); }
            else if (entry.isFile() && entry.name.toLowerCase().endsWith('.bsl')) {
                const source = await readFile(file, 'utf8');
                if (!source.toLowerCase().includes('добавитьшагвмассивтестов')) { continue; }
                hash.update(`${index}:${path.relative(sourceRoot, file).replace(/\\/gu, '/')}`).update(source);
                const sourceUri = pathToFileURL(file).toString();
                registrations.push(...parseStaticBslStepRegistrations(source, sourceUri).registrations.map(row => ({ ...row, sourceUri })));
            }
        }
    }
    const enriched = enrichStepCatalogCategories({ steps: parsed.steps, categoryTranslations: parsed.categories, registrations,
        fallbackCategoryPath: { ru: ['Служебные'], en: ['Service'] } });
    const catalog: LocalStepCatalog = { schemaVersion: 1, vanessaVersion: version, generatedAt: new Date().toISOString(),
        source: { kind: 'local', sha256: hash.digest('hex'), generatorVersion: LOCAL_STEP_CATALOG_GENERATOR_VERSION }, steps: sortStepCatalogDefinitions(enriched.steps) };
    resolveLocalStepCatalog(JSON.stringify(catalog), version);
    return catalog;
}
