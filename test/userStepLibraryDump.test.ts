import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dumpUserStepLibrary } from '../src/userStepLibraryDump';
import { inspectUserStepLibrary } from '../src/userStepLibraryState';
import type { UserStepLibraryBuildDependencies } from '../src/userStepLibraryBuilder';

async function harness(t: { after(fn: () => Promise<void>): void }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-step-dump-'));
    t.after(() => fs.rm(root, { force: true, recursive: true }));
    const epf = path.join(root, 'step_definitions', 'Steps.epf');
    const destination = path.join(root, 'step_definitions-src', 'Steps');
    await fs.mkdir(path.dirname(epf), { recursive: true });
    await fs.writeFile(epf, 'existing binary');
    const commands: string[][] = [];
    const dependencies: UserStepLibraryBuildDependencies = {
        pickPlatform: async () => ({ clientExePath: 'client.exe' }),
        ensureStartupInfobase: async () => ({ infobaseDirectory: root, authentication: null }),
        resolveDesignerPath: () => 'designer.exe', now: () => 1,
        fileSystem: { mkdir: async (p, options) => { await fs.mkdir(p, options); }, stat: fs.stat, rename: fs.rename, rm: fs.rm },
        runProcess: async command => {
            commands.push([...command.args]);
            const i = command.args.indexOf('/DumpExternalDataProcessorOrReportToFiles');
            assert.equal(command.args[i + 2], epf);
            await fs.writeFile(path.join(command.args[i + 1], 'Steps.xml'), '<ExternalDataProcessor/>');
            await fs.writeFile(path.join(command.args[i + 1], 'Module.bsl'), 'Процедура Шаг() Экспорт\nКонецПроцедуры');
            return { exitCode: 0, stdout: '', stderr: '' };
        }
    };
    return { root, epf, destination, commands, dependencies };
}

test('dump publishes source files only after successful Designer output and marks the pair ready', async t => {
    const h = await harness(t);
    const result = await dumpUserStepLibrary({ epfPath: h.epf, sourceDirectory: h.destination }, h.dependencies, { isCancellationRequested: false });
    assert.equal(result.kind, 'success');
    assert.equal(await fs.readFile(h.epf, 'utf8'), 'existing binary');
    assert.equal((await inspectUserStepLibrary(path.join(h.destination, 'Module.bsl'), h.root)).status, 'ready');
    assert.equal(h.commands.length, 1);
});

test('dump refuses existing sources before launching Designer', async t => {
    const h = await harness(t);
    await fs.mkdir(h.destination, { recursive: true });
    await fs.writeFile(path.join(h.destination, 'Module.bsl'), 'unsaved work on disk');
    await assert.rejects(() => dumpUserStepLibrary({ epfPath: h.epf, sourceDirectory: h.destination }, h.dependencies, { isCancellationRequested: false }), /already|exist/iu);
    assert.equal(await fs.readFile(path.join(h.destination, 'Module.bsl'), 'utf8'), 'unsaved work on disk');
    assert.equal(h.commands.length, 0);
});

test('dump keeps the EPF association when sources are placed in a differently named directory', async t => {
    const h = await harness(t);
    const destination = path.join(h.root, 'step_definitions-src', 'Imported');
    await dumpUserStepLibrary({ epfPath: h.epf, sourceDirectory: destination }, h.dependencies, { isCancellationRequested: false });
    const state = await inspectUserStepLibrary(path.join(destination, 'Module.bsl'), h.root);
    assert.equal(state.status, 'ready');
    assert.equal(state.targetEpfPath, h.epf);
});

test('failed or cancelled dump does not publish partial sources', async t => {
    for (const cancel of [false, true]) {
        const h = await harness(t);
        const token = { isCancellationRequested: false };
        const operation = dumpUserStepLibrary({ epfPath: h.epf, sourceDirectory: h.destination }, {
            ...h.dependencies,
            runProcess: async (command, currentToken) => {
                await h.dependencies.runProcess(command, currentToken);
                token.isCancellationRequested = cancel;
                return { exitCode: cancel ? 0 : 1, stdout: '', stderr: 'dump failed' };
            }
        }, token);
        if (cancel) { assert.deepEqual(await operation, { kind: 'cancelled' }); }
        else { await assert.rejects(() => operation, /dump/iu); }
        await assert.rejects(() => fs.stat(h.destination), /ENOENT/u);
        assert.equal(await fs.readFile(h.epf, 'utf8'), 'existing binary');
    }
});
