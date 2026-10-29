import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { inspectUserStepLibrary, isUserStepAvailable, userStepSourceFingerprint, writeUserStepBuildState } from '../src/userStepLibraryState';

test('Windows library lookup stops at its root despite path casing differences', async () => {
    const visited: string[] = []; const nativeRequire = createRequire(__filename);
    const exports = {} as typeof import('../src/userStepLibraryState');
    const missing = () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    const source = await fs.readFile(path.join(process.cwd(), 'src/userStepLibraryState.ts'), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
        exports, require: (id: string) => {
            if (id === 'node:path') { return path.win32; }
            if (id === 'node:fs') { return { promises: { readFile: missing, stat: missing, readdir: async (directory: string) => {
                visited.push(directory);
                // Bound the old endless walk without letting it starve the test event loop.
                if (visited.length > 30) { return new Promise(() => {}); }
                return [];
            } } }; }
            if (id === './projectDefinition') { return {}; }
            return nativeRequire(id);
        }
    });
    const result = await Promise.race([exports.inspectUserStepLibrary('C:\\Library\\steps.bsl', 'c:\\library'),
        new Promise<undefined>(resolve => setImmediate(() => resolve(undefined)))]);
    assert.equal(result?.status, 'sourceOnly');
    assert.ok(visited.every(directory => !path.win32.relative('c:\\library', directory).startsWith('..')), visited.join(', '));
});

test('only a matching EPF and source fingerprint make a library available', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-step-state-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'step_definitions-src', 'Steps');
    const source = path.join(directory, 'Module.bsl');
    const xml = path.join(directory, 'Обработка.xml');
    const binary = path.join(root, 'step_definitions', 'Steps.epf');
    await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(source, 'old source');
    assert.equal((await inspectUserStepLibrary(source, root)).status, 'sourceOnly');
    await fs.writeFile(xml, '<processor/>');
    assert.equal((await inspectUserStepLibrary(source, root)).status, 'uncompiled');
    await fs.writeFile(binary, 'binary');
    assert.equal((await inspectUserStepLibrary(source, root)).status, 'stale', 'An unrelated binary is not proof of a build');
    await writeUserStepBuildState(xml, binary, await userStepSourceFingerprint(xml));
    assert.equal((await inspectUserStepLibrary(source, root)).status, 'ready');
    await fs.writeFile(path.join(directory, '.DS_Store'), 'Finder metadata');
    assert.equal((await inspectUserStepLibrary(source, root)).status, 'ready', 'Opening the directory in Finder must not invalidate a build');
    const stat = await fs.stat(source);
    await fs.writeFile(source, 'new source');
    await fs.utimes(source, stat.atime, stat.mtime);
    assert.equal((await inspectUserStepLibrary(source, root)).status, 'stale', 'Content changes must be detected even with the same timestamp');
    await writeUserStepBuildState(xml, binary, await userStepSourceFingerprint(xml));
    await fs.writeFile(binary, 'other binary');
    assert.equal((await inspectUserStepLibrary(source, root)).status, 'stale');
    await fs.rm(binary);
    assert.equal((await inspectUserStepLibrary(source, root)).status, 'uncompiled');
});

test('availability is strict for user steps and does not block other definitions', () => {
    assert.equal(isUserStepAvailable({ kind: 'userStep' }), false);
    for (const status of ['sourceOnly', 'uncompiled', 'stale', 'ready'] as const) {
        assert.equal(isUserStepAvailable({ kind: 'userStep', userStepLibrary: { status, sourceDirectory: '/src' } }), status === 'ready');
    }
    assert.equal(isUserStepAvailable({ kind: 'exportScenario' }), true);
});

test('recognizes an existing wrapper by its name and exact module contents, retaining the association after edits', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-imported-step-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const original = path.join(root, 'user-steps', 'Steps.bsl');
    const project = path.join(root, 'step_definitions-src', 'Steps');
    const module = path.join(project, 'Обработка/Forms/Форма/Ext/Form/Module.bsl');
    await fs.mkdir(path.dirname(original), { recursive: true });
    await fs.mkdir(path.dirname(module), { recursive: true });
    await fs.writeFile(path.join(project, 'Обработка.xml'), '<ExternalDataProcessor/>');
    await fs.writeFile(original, 'original implementation');
    await fs.writeFile(module, 'different implementation');
    assert.equal((await inspectUserStepLibrary(original, root)).importedModulePath, undefined, 'A shared name alone must not merge independent sources');
    await fs.writeFile(module, 'original implementation');
    assert.equal((await inspectUserStepLibrary(original, root)).importedModulePath, module);
    await fs.writeFile(module, 'edited implementation');
    assert.equal((await inspectUserStepLibrary(original, root)).importedModulePath, module, 'A migrated association must survive subsequent module edits');
    const independent = path.join(root, 'user-steps', 'Independent.bsl');
    await fs.writeFile(independent, 'edited implementation');
    assert.equal((await inspectUserStepLibrary(independent, root)).importedModulePath, undefined, 'Matching content in a differently named source is insufficient');
});

test('an import marker cannot suppress a source using a target outside its configured library', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-import-boundary-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'Steps.bsl');
    await fs.writeFile(source, 'implementation');
    await fs.writeFile(source + '.kot-import.json', JSON.stringify({ version: 1, modulePath: '../unrelated/Module.bsl' }));
    assert.equal((await inspectUserStepLibrary(source, root)).importedModulePath, undefined);
});
