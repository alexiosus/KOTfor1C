import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface UserStepLibraryState {
    readonly status: 'sourceOnly' | 'uncompiled' | 'stale' | 'ready';
    readonly sourceDirectory: string;
    readonly rootXmlPath?: string;
    readonly targetEpfPath?: string;
    readonly importedModulePath?: string;
}

const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const userStepBinaryFingerprint = async (epf: string): Promise<string> => digest(await fs.readFile(epf));
export const userStepBuildStatePath = (epf: string): string => epf + '.kot-build.json';
export { isUserStepAvailable } from './projectDefinition';

export async function recordUserStepSourceImport(sourcePath: string, modulePath: string): Promise<void> {
    const marker = sourcePath + '.kot-import.json';
    const relative = path.relative(path.dirname(sourcePath), modulePath).split(path.sep).join('/');
    const contents = JSON.stringify({ version: 1, modulePath: relative }, null, 4) + '\n';
    try {
        await fs.writeFile(marker, contents, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
        const existing = JSON.parse(await fs.readFile(marker, 'utf8'));
        if (existing.version !== 1 || typeof existing.modulePath !== 'string') {
            throw new Error('The BSL source is already associated with another user-step library.');
        }
        const previousModule = path.resolve(path.dirname(sourcePath), existing.modulePath);
        if (previousModule === path.resolve(modulePath)) { return; }
        const previous = await fs.stat(previousModule).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
            return undefined;
        });
        if (previous) { throw new Error('The BSL source is already associated with another user-step library.'); }
        const temporary = marker + `.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, contents, 'utf8');
            await fs.rename(temporary, marker);
        } finally { await fs.rm(temporary, { force: true }); }
    }
}

async function importedUserStepModule(sourcePath: string, root: string): Promise<string | undefined> {
    const sourceRoot = path.join(root, 'step_definitions-src');
    try {
        const marker = JSON.parse(await fs.readFile(sourcePath + '.kot-import.json', 'utf8'));
        if (marker.version !== 1 || typeof marker.modulePath !== 'string') { return undefined; }
        const target = path.resolve(path.dirname(sourcePath), marker.modulePath);
        const relative = path.relative(sourceRoot, target);
        if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
            || !target.toLowerCase().endsWith('.bsl') || target === path.resolve(sourcePath)) { return undefined; }
        const project = path.join(sourceRoot, relative.split(path.sep)[0]);
        return (await fs.stat(target)).isFile() && await findUserStepRootXml(project) ? target : undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { return undefined; }
    }

    // Earlier versions retained the original BSL without recording its generated wrapper.
    const project = path.join(sourceRoot, path.basename(sourcePath, path.extname(sourcePath)));
    const module = path.join(project, 'Обработка', 'Forms', 'Форма', 'Ext', 'Form', 'Module.bsl');
    try {
        if (!await findUserStepRootXml(project)) { return undefined; }
        const [original, generated] = await Promise.all([fs.readFile(sourcePath), fs.readFile(module)]);
        if (!original.equals(generated)) { return undefined; }
        await recordUserStepSourceImport(sourcePath, module);
        return module;
    } catch { return undefined; }
}

export async function userStepSourceFingerprint(rootXmlPath: string): Promise<string> {
    const root = path.dirname(rootXmlPath);
    const records: Array<[string, string]> = [];
    async function visit(directory: string): Promise<void> {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (['.git', '.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(entry.name) || entry.name.startsWith('.kot-')) { continue; }
            const target = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) { throw new Error('User-step sources must not contain symbolic links.'); }
            if (entry.isDirectory()) { await visit(target); }
            else if (entry.isFile()) {
                records.push([path.relative(root, target).split(path.sep).join('/'), digest(await fs.readFile(target))]);
            }
        }
    }
    await fs.stat(rootXmlPath);
    await visit(root);
    records.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return digest(JSON.stringify(records));
}

export async function writeUserStepBuildState(rootXmlPath: string, targetEpfPath: string, sourceFingerprint: string, expectedEpfFingerprint?: string): Promise<void> {
    if (await userStepSourceFingerprint(rootXmlPath) !== sourceFingerprint) {
        throw new Error('User-step sources changed during the build. Save and rebuild the library.');
    }
    const epfFingerprint = await userStepBinaryFingerprint(targetEpfPath);
    if (expectedEpfFingerprint !== undefined && epfFingerprint !== expectedEpfFingerprint) { throw new Error('The EPF changed before its build state was recorded.'); }
    await fs.writeFile(path.join(path.dirname(rootXmlPath), '.kot-library.json'), JSON.stringify({
        version: 1, epfPath: path.relative(path.dirname(rootXmlPath), targetEpfPath).split(path.sep).join('/')
    }, null, 4) + '\n', 'utf8');
    const manifest = userStepBuildStatePath(targetEpfPath);
    const temporary = path.join(path.dirname(manifest), `.kot-build-state-${randomUUID()}.json`);
    try {
        await fs.writeFile(temporary, JSON.stringify({
            version: 1, sourceFingerprint, epfFingerprint
        }, null, 4) + '\n', 'utf8');
        await fs.rename(temporary, manifest);
    } finally {
        await fs.rm(temporary, { force: true });
    }
}

export async function findUserStepRootXml(directory: string): Promise<string | undefined> {
    const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const preferred = files.find(entry => entry.isFile() && entry.name === 'Обработка.xml');
    if (preferred) { return path.join(directory, preferred.name); }
    for (const entry of files) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) {
            const file = path.join(directory, entry.name);
            if (/<(?:\w+:)?ExternalDataProcessor\b/u.test(await fs.readFile(file, 'utf8'))) { return file; }
        }
    }
    return undefined;
}

export async function inspectUserStepLibrary(sourcePath: string, libraryRootPath: string): Promise<UserStepLibraryState> {
    const root = path.resolve(libraryRootPath);
    let directory = path.dirname(path.resolve(sourcePath));
    const relative = path.relative(root, directory);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
        return { status: 'sourceOnly', sourceDirectory: directory };
    }
    while (true) {
        const rootXmlPath = await findUserStepRootXml(directory);
        if (rootXmlPath) {
            let targetEpfPath = path.join(root, 'step_definitions', `${path.basename(directory)}.epf`);
            try {
                const association = JSON.parse(await fs.readFile(path.join(directory, '.kot-library.json'), 'utf8'));
                if (association.version !== 1 || typeof association.epfPath !== 'string' || !association.epfPath.toLowerCase().endsWith('.epf')) {
                    return { status: 'stale', sourceDirectory: directory, rootXmlPath };
                }
                targetEpfPath = path.resolve(directory, association.epfPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { return { status: 'stale', sourceDirectory: directory, rootXmlPath }; }
            }
            const base = { sourceDirectory: directory, rootXmlPath, targetEpfPath };
            const binary = await fs.stat(targetEpfPath).catch(() => undefined);
            if (!binary?.isFile() || binary.size === 0) { return { ...base, status: 'uncompiled' }; }
            try {
                const state = JSON.parse(await fs.readFile(userStepBuildStatePath(targetEpfPath), 'utf8'));
                const ready = state.version === 1
                    && state.sourceFingerprint === await userStepSourceFingerprint(rootXmlPath)
                    && state.epfFingerprint === digest(await fs.readFile(targetEpfPath));
                return { ...base, status: ready ? 'ready' : 'stale' };
            } catch { return { ...base, status: 'stale' }; }
        }
        if (directory === root) { break; }
        directory = path.dirname(directory);
    }
    const importedModulePath = await importedUserStepModule(sourcePath, root);
    return { status: 'sourceOnly', sourceDirectory: path.dirname(sourcePath), ...(importedModulePath ? { importedModulePath } : {}) };
}
