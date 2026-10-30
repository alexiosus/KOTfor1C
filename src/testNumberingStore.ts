import fs from 'node:fs/promises';
import path from 'node:path';
import { isMap, isSeq, parseDocument, visit } from 'yaml';
import { readPropertyCatalogFile, serializePropertyCatalogWrite, validatePropertyCatalogName, writePropertyCatalogFile } from './projectPropertyCatalogStore';
import { assertProjectFormat3, assertProjectFormatUnchanged, projectFormat } from './projectFormat';
import { assertProjectTransitionBranch } from './projectFormatTransition';

export interface TestNumberingSeries { prefix: string; author: string; lastNumber: number }
export type TestNumberingDefinition = Pick<TestNumberingSeries, 'prefix' | 'author'>;
export interface TestNumberingCatalog { version: 1; series: TestNumberingSeries[] }
export interface TestNumberingStoreOptions { beforeWrite?: () => void | Promise<void> }

function validatePrefix(prefix: unknown): asserts prefix is string {
    if (typeof prefix !== 'string' || !/^\d{6}$/u.test(prefix)) { throw new Error('A numbering prefix must contain exactly six digits.'); }
}

/** Manual identifiers remain valid folder names; automatic identifiers are nine-digit strings. */
export function validateNewTestCode(code: string, numericOnly = false): string | undefined {
    if (!code.trim()) { return 'Code cannot be empty'; }
    if (numericOnly && !/^\d+$/u.test(code.trim())) { return 'Code must contain digits only'; }
    if (/[/\\:*?"<>|\x00-\x1f]/u.test(code) || /[. ]$/u.test(code) || ['.', '..', '.git', '.kot', 'node_modules'].includes(code.toLowerCase())
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(code)) { return 'Code contains invalid folder characters'; }
    return undefined;
}

export function parseNumberingCatalog(text?: string) {
    const document = parseDocument(text ?? 'version: 1\nseries: []\n');
    let alias = false; visit(document, { Alias: () => { alias = true; } });
    if (document.errors.length || document.warnings.length || !isMap(document.contents) || alias) {
        throw new Error('Invalid or ambiguous test numbering catalog YAML.');
    }
    const data = document.toJS() as Record<string, unknown>;
    if (data.version !== 1 || Object.keys(data).some(key => !['version', 'series'].includes(key)) || !Array.isArray(data.series)) {
        throw new Error('Unsupported test numbering catalog schema or version.');
    }
    const series: TestNumberingSeries[] = data.series.map(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)
            || Object.keys(entry).some(key => !['prefix', 'author', 'lastNumber'].includes(key))) { throw new Error('Invalid test numbering series.'); }
        validatePrefix(entry.prefix);
        const author = validatePropertyCatalogName(entry.author);
        if (!Number.isInteger(entry.lastNumber) || entry.lastNumber < 0 || entry.lastNumber > 999) { throw new Error('Invalid last issued numbering value.'); }
        return { prefix: entry.prefix, author, lastNumber: entry.lastNumber };
    });
    if (new Set(series.map(entry => entry.prefix)).size !== series.length) { throw new Error('Duplicate test numbering prefix in catalog.'); }
    return { document, catalog: { version: 1 as const, series } };
}

function highestNumber(prefix: string, codes: readonly string[]): number {
    return codes.reduce((highest, code) => /^\d{9}$/u.test(code) && code.startsWith(prefix) ? Math.max(highest, Number(code.slice(6))) : highest, 0);
}

function definitions(entries: readonly TestNumberingDefinition[]): TestNumberingDefinition[] {
    if (!Array.isArray(entries)) { throw new Error('Numbering series must contain an array.'); }
    const result = entries.map(entry => {
        if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['prefix', 'author'].includes(key))) { throw new Error('Invalid numbering series definition.'); }
        validatePrefix(entry.prefix); return { prefix: entry.prefix, author: validatePropertyCatalogName(entry.author) };
    });
    if (new Set(result.map(entry => entry.prefix)).size !== result.length) { throw new Error('Duplicate test numbering prefix in catalog.'); }
    return result;
}

export class TestNumberingStore {
    readonly filePath: string;
    private readonly root: string;
    private readonly lock: string;
    constructor(root: string, private readonly options: TestNumberingStoreOptions = {}) {
        this.root = path.resolve(root);
        this.filePath = path.join(this.root, '.kot', 'test-numbering.yml');
        this.lock = path.join(this.root, '.kot', 'test-numbering.lock');
    }
    private async safePath(): Promise<void> {
        for (const file of [path.join(this.root, '.kot'), this.filePath]) {
            try { if ((await fs.lstat(file)).isSymbolicLink()) { throw new Error('Test numbering catalogs cannot use a symbolic link.'); } }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        }
    }
    private exclusive<T>(operation: () => Promise<T>): Promise<T> {
        return serializePropertyCatalogWrite(this.filePath, async () => {
            await this.safePath();
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            const handle = await fs.open(this.lock, 'wx').catch(error => {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') { throw new Error('Test numbering is locked by another operation. Retry when it finishes.'); }
                throw error;
            });
            try { return await operation(); }
            finally { await handle.close(); await fs.rm(this.lock, { force: true }); }
        });
    }
    async read(): Promise<TestNumberingCatalog> {
        if(projectFormat(this.root).kind!=='v3'){return {version:1,series:[]};}
        await this.safePath(); return parseNumberingCatalog(await readPropertyCatalogFile(this.filePath)).catalog;
    }
    async addSeries(prefix: string, author: string, codes: readonly string[]): Promise<TestNumberingSeries> {
        validatePrefix(prefix); const name = validatePropertyCatalogName(author);
        return this.exclusive(async () => {
            const original = await readPropertyCatalogFile(this.filePath);
            const { document, catalog } = parseNumberingCatalog(original);
            if (catalog.series.some(entry => entry.prefix === prefix)) { throw new Error('A numbering series with this prefix already exists.'); }
            const entry = { prefix, author: name, lastNumber: highestNumber(prefix, codes) };
            document.addIn(['series'], entry);
            await writePropertyCatalogFile(this.filePath, document.toString(), original, async () => { await this.safePath(); await this.options.beforeWrite?.(); });
            return entry;
        });
    }
    async suggest(prefix: string, codes: readonly string[]): Promise<string> {
        const entry = (await this.read()).series.find(entry => entry.prefix === prefix);
        if (!entry) { throw new Error('The selected numbering series no longer exists. Choose a series again.'); }
        const next = Math.max(entry.lastNumber, highestNumber(prefix, codes)) + 1;
        if (next > 999) { throw new Error('The numbering series is exhausted. Add a new series.'); }
        return prefix + String(next).padStart(3, '0');
    }
    async replaceSeries(entries: readonly TestNumberingDefinition[], expected: readonly TestNumberingDefinition[],
        loadCodes: () => Promise<readonly string[]>): Promise<void> {
        const updated = definitions(entries); const before = definitions(expected);
        return this.exclusive(async () => {
            const original = await readPropertyCatalogFile(this.filePath);
            const { document, catalog } = parseNumberingCatalog(original);
            const current = catalog.series.map(({ prefix, author }) => ({ prefix, author }));
            if (JSON.stringify(current) !== JSON.stringify(before)) { throw new Error('Numbering series changed. Refresh and retry.'); }
            const codes = await loadCodes();
            for (const removed of catalog.series.filter(entry => !updated.some(value => value.prefix === entry.prefix))) {
                if (removed.lastNumber > 0 || codes.some(code => /^\d{9}$/u.test(code) && code.startsWith(removed.prefix))) {
                    throw new Error('Cannot remove a numbering series with issued test codes. Keep its history.');
                }
            }
            // Preserve comments on surviving records instead of replacing the entire YAML sequence.
            const sequence = document.get('series', true);
            if (!isSeq(sequence)) { throw new Error('Invalid numbering series YAML.'); }
            const previousItems = new Map(catalog.series.map((entry, index) => [entry.prefix, sequence.items[index]]));
            sequence.items = updated.map(entry => {
                const old = catalog.series.find(value => value.prefix === entry.prefix);
                const lastNumber = Math.max(old?.lastNumber ?? 0, highestNumber(entry.prefix, codes));
                const node = previousItems.get(entry.prefix);
                if (isMap(node)) { node.set('author', entry.author); node.set('lastNumber', lastNumber); return node; }
                return document.createNode({ ...entry, lastNumber });
            });
            await writePropertyCatalogFile(this.filePath, document.toString(), original, async () => { await this.safePath(); await this.options.beforeWrite?.(); });
        });
    }
    /** A claim happens after wizard confirmation; never roll counters back after a failed creation. */
    async claim(code: string, loadCodes: () => Promise<readonly string[]>, expectedSeries?: Pick<TestNumberingSeries, 'prefix' | 'author'>,
        create?: () => Promise<void>): Promise<string | undefined> {
        const invalid = validateNewTestCode(code); if (invalid) { throw new Error(invalid); }
        const format=projectFormat(this.root);
        if(format.kind!=='v3'){
            return serializePropertyCatalogWrite(path.join(this.root,'.legacy-code-claim'),async()=>{
                assertProjectTransitionBranch(this.root);assertProjectFormatUnchanged(this.root,format);
                if(expectedSeries){assertProjectFormat3(this.root);}
                const codes=await loadCodes();
                assertProjectFormatUnchanged(this.root,format);
                if(codes.some(value=>value.toLocaleLowerCase()===code.toLocaleLowerCase())){throw new Error(`Test code "${code}" already exists.`);}
                await create?.();return undefined;
            });
        }
        return this.exclusive(async () => {
            const original = await readPropertyCatalogFile(this.filePath);
            const { document, catalog } = parseNumberingCatalog(original);
            if (expectedSeries && !catalog.series.some(entry => entry.prefix === expectedSeries.prefix && entry.author === expectedSeries.author)) {
                throw new Error('The selected numbering series changed. Choose a series again.');
            }
            const codes = await loadCodes();
            if (codes.some(value => value.toLocaleLowerCase() === code.toLocaleLowerCase())) { throw new Error(`Test code "${code}" already exists.`); }
            const index = catalog.series.findIndex(entry => /^\d{9}$/u.test(code) && code.startsWith(entry.prefix));
            if (index < 0) { await create?.(); return undefined; }
            const entry = catalog.series[index]; const number = Number(code.slice(6));
            if (number <= Math.max(entry.lastNumber, highestNumber(entry.prefix, codes))) {
                throw new Error('This number has already been issued. Choose the next number in the series.');
            }
            document.setIn(['series', index, 'lastNumber'], number);
            await writePropertyCatalogFile(this.filePath, document.toString(), original, async () => { await this.safePath(); await this.options.beforeWrite?.(); });
            await create?.();
            return entry.author;
        });
    }
}
