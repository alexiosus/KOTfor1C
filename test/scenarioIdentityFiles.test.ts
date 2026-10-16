import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import vm from 'node:vm';
import * as snapshots from '../src/scenarioNativeDocumentSnapshot';
import * as yaml from '../src/scenarioYamlDocument';
import * as prepared from '../src/preparedFileWrites';

async function fixture(t: test.TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-identity-files-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, '001');
    await fs.mkdir(path.join(directory, 'test'), { recursive: true });
    const source = path.join(directory, 'scen.yaml');
    const settings = path.join(directory, 'test', '001.yaml');
    const custom = path.join(directory, 'test', 'Custom.yaml');
    const before = '\uFEFFТипФайла: Сценарий\r\nДанныеСценария:\r\n    UID: scenario\r\n    Имя: Old\r\n    Код: "001"\r\nТекстСценария: |\r\n    And a step\r\n';
    await fs.writeFile(source, before);
    await fs.writeFile(settings, 'ТипФайла: НастройкаТеста\nДанныеТеста:\n    UIDСценария: scenario\n    Код: "001"\n');
    await fs.writeFile(custom, 'ТипФайла: НастройкаТеста\nДанныеТеста:\n    UIDСценария: scenario\n    Код: Custom\n');
    await fs.writeFile(`${source}.kot.yml`, 'version: 2\nidentity:\n  kind: scenario\n  uid: scenario\nmetadata:\n  description: Text\n');
    await fs.writeFile(`${settings}.kot.yml`, 'preserved sidecar');
    const uri = (file: string) => ({ fsPath: file, scheme: 'file', toString: () => `file://${file}` });
    const document = { uri: uri(source), version: 1, isClosed: false, isDirty: false, text: before.slice(1), getText() { return this.text; } };
    const documents = [document];
    const moves: { oldUri: ReturnType<typeof uri>; newUri: ReturnType<typeof uri> }[] = [];
    let failAfter = -1;
    let duringFailure: (() => Promise<void>) | undefined;
    class Edit {
        moves: typeof moves = [];
        renameFile(oldUri: ReturnType<typeof uri>, newUri: ReturnType<typeof uri>) { this.moves.push({ oldUri, newUri }); }
    }
    const host = { Uri: { file: uri }, WorkspaceEdit: Edit, workspace: { textDocuments: documents,
        fs: { writeFile: async (resource: ReturnType<typeof uri>, bytes: Uint8Array) => {
            await fs.writeFile(resource.fsPath, bytes);
            for (const doc of documents.filter(doc => doc.uri.fsPath === resource.fsPath)) { doc.text = Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/u, ''); doc.version++; }
        } },
        applyEdit: async (edit: Edit) => {
            for (const move of edit.moves) {
                await fs.rename(move.oldUri.fsPath, move.newUri.fsPath); moves.push(move);
                for (const doc of documents) {
                    const relative = path.relative(move.oldUri.fsPath, doc.uri.fsPath);
                    if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) { doc.uri = uri(path.join(move.newUri.fsPath, relative)); }
                }
                if (failAfter === moves.length) { failAfter = -1; await duringFailure?.(); throw new Error('native rename failed'); }
            }
            return true;
        }
    } };
    const ts = require('typescript') as typeof import('typescript');
    const module = { exports: {} as any };
    const code = await fs.readFile(path.join(process.cwd(), 'src/scenarioIdentityFiles.ts'), 'utf8');
    const dependencies: Record<string, unknown> = { vscode: host, './scenarioNativeDocumentSnapshot': snapshots, './scenarioYamlDocument': yaml, './preparedFileWrites': prepared };
    vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, Buffer, console, setTimeout, clearTimeout, require: (name: string) => dependencies[name] ?? require(name) });
    const prepare = (overrides: Record<string, unknown> = {}) => module.exports.prepareScenarioIdentityFileChanges({ sourceUri: uri(source), uid: 'scenario', oldCode: '001', code: '002', relatedUris: [uri(settings), uri(custom)], definitionUris: [uri(source)], protectedDirectories: [root], ...overrides });
    return { root, directory, source, settings, custom, before, document, documents, moves, prepare, uri,
        failAfter(count: number, callback?: () => Promise<void>) { failAfter = count; duringFailure = callback; } };
}

test('code changes move the dedicated folder, matching settings and sidecars through native edits', async t => {
    const f = await fixture(t); const plan = await f.prepare();
    const after = f.before.replace('Код: "001"', 'Код: "002"');
    await plan.apply([{ key: f.uri(f.source), before: f.before, after }]);
    const destination = path.join(f.root, '002');
    assert.equal(await fs.readFile(path.join(destination, 'scen.yaml'), 'utf8'), after);
    assert.ok(await fs.stat(path.join(destination, 'test', '002.yaml')));
    assert.ok(await fs.stat(path.join(destination, 'test', '002.yaml.kot.yml')));
    assert.ok(await fs.stat(path.join(destination, 'test', 'Custom.yaml')));
    assert.ok(await fs.stat(path.join(destination, 'scen.yaml.kot.yml')));
    assert.equal(plan.result.sourceUri, f.uri(path.join(destination, 'scen.yaml')).toString());
    assert.equal(f.document.uri.toString(), plan.result.sourceUri);
    assert.equal(f.moves.length, 3);
});

test('code changes preserve shared and protected source folders', async t => {
    for (const shared of [false, true]) {
        const f = await fixture(t);
        const other = path.join(f.directory, 'other.yaml');
        if (shared) { await fs.writeFile(other, 'ТипФайла: Процесс\nДанныеПроцесса:\n    UID: other\n    Имя: Other\n'); }
        const plan = await f.prepare(shared ? { definitionUris: [f.uri(f.source), f.uri(other)] } : { protectedDirectories: [f.root, f.directory] });
        await plan.apply([]);
        assert.ok(await fs.stat(f.source));
        assert.equal(plan.result.sourceUri, f.uri(f.source).toString());
        assert.ok(await fs.stat(path.join(f.directory, 'test', '002.yaml')));
    }
});

test('rename targets and unsafe codes reject without changing source files', async t => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.root, '002'));
    await assert.rejects(f.prepare(), /already exists/u);
    for (const code of ['../escape', '.git', '.kot', 'node_modules']) { await assert.rejects(f.prepare({ code }), /valid.*code/u); }
    assert.equal(await fs.readFile(f.source, 'utf8'), f.before);
    assert.deepEqual(f.moves, []);
});

test('dirty assets and external changes prevent identity writes and moves', async t => {
    const f = await fixture(t); const plan = await f.prepare();
    const asset = path.join(f.directory, 'notes.txt'); await fs.writeFile(asset, 'external');
    await assert.rejects(plan.apply([{ key: f.uri(f.source), before: f.before, after: f.before.replace('001', '002') }]), /changed/u);
    assert.equal(await fs.readFile(f.source, 'utf8'), f.before);
    const second = await f.prepare();
    f.documents.push({ ...f.document, uri: f.uri(asset), isDirty: true, text: 'unsaved' });
    await assert.rejects(second.apply([]), /Save modified/u);
    assert.deepEqual(f.moves, []);
});

test('a partial native rename failure restores matching filenames and source content', async t => {
    const f = await fixture(t); const plan = await f.prepare(); f.failAfter(1);
    await assert.rejects(plan.apply([{ key: f.uri(f.source), before: f.before, after: f.before.replace('001', '002') }]), /native rename failed/u);
    assert.equal(await fs.readFile(f.source, 'utf8'), f.before);
    assert.ok(await fs.stat(f.settings));
    assert.ok(await fs.stat(`${f.settings}.kot.yml`));
    await assert.rejects(fs.stat(path.join(f.root, '002')), { code: 'ENOENT' });
});

test('a canonical dedicated folder left behind by an earlier code edit follows the next code', async t => {
    const f = await fixture(t);
    const current = f.before.replace('Код: "001"', 'Код: "009"');
    await fs.writeFile(f.source, current); f.document.text = current.slice(1);
    await fs.writeFile(f.settings, (await fs.readFile(f.settings, 'utf8')).replace('"001"', '"009"'));
    const plan = await f.prepare({ oldCode: '009' });
    await plan.apply([{ key: f.uri(f.source), before: current, after: current.replace('"009"', '"002"') }]);
    assert.ok(await fs.stat(path.join(f.root, '002', 'scen.yaml')));
    assert.ok(await fs.stat(path.join(f.root, '002', 'test', '002.yaml')));
    assert.ok(await fs.stat(path.join(f.root, '002', 'test', 'Custom.yaml')));
});

test('rollback preserves an external source change made after native rename began', async t => {
    const f = await fixture(t); const plan = await f.prepare();
    const after = f.before.replace('"001"', '"002"'); const external = after + '# external change\r\n';
    f.failAfter(1, () => fs.writeFile(f.source, external));
    await assert.rejects(plan.apply([{ key: f.uri(f.source), before: f.before, after }]), /rollback was incomplete/u);
    assert.equal(await fs.readFile(f.source, 'utf8'), external);
    assert.ok(await fs.stat(f.settings));
});

test('a flat source outside moved resources is checked again before writing its code', async t => {
    const f = await fixture(t); const plan = await f.prepare({ protectedDirectories: [f.root, f.directory] });
    const external = f.before + '# external saved edit\r\n';
    await fs.writeFile(f.source, external);
    await assert.rejects(plan.apply([{ key: f.uri(f.source), before: f.before, after: f.before.replace('"001"', '"002"') }]), /changed/u);
    assert.equal(await fs.readFile(f.source, 'utf8'), external);
    assert.deepEqual(f.moves, []);
});
