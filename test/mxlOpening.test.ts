import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { buildVanessaMxlStep, readMxlOpeningResult } from '../src/mxlOpening';
import { redactVanessaDiagnosticText } from '../src/vanessaControlRedaction';
import { OneCInfobasePlatformError } from '../src/oneCInfobasePlatform';
import { loadSharedStartupPlatform } from './helpers/sharedStartupPlatformFixture';

test('MXL paths are data rather than BSL or Gherkin substitutions, and opening requires an explicit acknowledgement', () => {
    const file = 'C:\\test "$Variable$"\\Макет с пробелами.mxl'; const result = 'C:\\runtime\\result.json';
    const step = buildVanessaMxlStep(file, result);
    assert.ok(!step.includes(file)); assert.ok(!step.includes('$Variable$'));
    assert.deepEqual([...step.matchAll(/Base64Значение\("([^"]+)"\)/gu)].map(match => Buffer.from(match[1], 'base64').toString('utf8')), [file, result]);
    assert.equal(step.split('\n')[0], 'И я выполняю код встроенного языка');
    assert.ok(step.includes('Ванесса.ПолучитьМакетИзФайла'));
    assert.doesNotThrow(() => readMxlOpeningResult('{"opened":true}'));
    for (const value of ['{}', '{"opened":"true"}', '{"opened":false}', 'null']) { assert.throws(() => readMxlOpeningResult(value)); }
    assert.throws(() => readMxlOpeningResult('{"opened":false,"error":"Unreadable template"}'), /Unreadable template/u);
    assert.throws(() => buildVanessaMxlStep('file\n.mxl', result));
});

async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-mxl-opening-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const toUri = (file: string) => ({ scheme: 'file', fsPath: file, toString: () => pathToFileURL(file).toString() });
    const executable = path.join(root, 'file workshop.exe'); await fs.writeFile(executable, 'fixture');
    const document = toUri(path.join(root, 'Макет с пробелами.MXL')); await fs.writeFile(document.fsPath, 'fixture');
    let mode = 'fileWorkshop'; let trusted = true; let selected = true; let prepared = 0; let failure: string | undefined;
    let runningPlatform: string | undefined; let discoveryError: unknown;
    const resolved: unknown[] = []; const observedBases: string[] = []; const preparedPlatforms: string[] = [];
    const launches: Array<{ executable: string; args: string[]; windowsHide: boolean }> = []; const external: string[] = []; const vanessa: string[] = []; const progress: string[] = [];
    const session = { snapshot: { capabilities: undefined as unknown }, openMxlFile: async (file: string) => { vanessa.push(file); } };
    const vscode = { Uri: { joinPath: (uri: any, ...parts: string[]) => toUri(path.join(uri.fsPath, ...parts)) }, l10n: { t: (text: string, ...args: unknown[]) => text.replace(/\{(\d+)\}/gu, (_, index) => String(args[Number(index)])) },
        ProgressLocation: { Notification: 15 }, env: { openExternal: async (uri: any) => { external.push(uri.fsPath); return true; } },
        workspace: { get isTrusted() { return trusted; }, getWorkspaceFolder: () => ({ uri: toUri(root) }), workspaceFolders: [{ uri: toUri(root) }],
            getConfiguration: () => ({ get: (key: string) => key === 'files.mxlOpeningMode' ? mode : executable }) },
        window: { withProgress: async (_options: unknown, work: Function) => work({ report: (value: { message: string }) => progress.push(value.message) }) } };
    const module = { exports: {} as any }; const ts = require('typescript') as typeof import('typescript');
    const requireDependency = (name: string): unknown => {
        if (name === './sharedStartupPlatform') { return sharedPlatform; }
        if (name === 'vscode') { return vscode; }
        if (name === './mxlOpening') { return { readMxlOpeningResult }; }
        if (name === './vanessaControlRedaction') { return { redactVanessaDiagnosticText }; }
        if (name === './oneCPlatform') { return { normalizeOneCClientExePath: (exe: string) => exe,
            resolveOneCPlatformForLaunch: async (_translate: unknown, options: unknown) => { resolved.push(options); return selected ? { clientExePath: '1cv8c.exe' } : null; } }; }
        if (name === './oneCInfobasePlatform') { return { OneCInfobasePlatformError, runningOneCInfobasePlatform: async (base: string) => {
            observedBases.push(base); if (discoveryError) { throw discoveryError; } return runningPlatform;
        } }; }
        if (name === './oneCInfobaseConnection') { return { buildFileInfobaseConnectionArgument: (base: string) => `File=${base};` }; }
        if (name === './startupInfobase') { return { getSharedStartupInfobasePaths: () => ({ rootDirectory: root, infobaseDirectory: path.join(root, 'ib') }),
            ensureSharedStartupInfobaseReady: async (_context: unknown, exe: string) => { prepared++; preparedPlatforms.push(exe); return { infobaseDirectory: path.join(root, 'ib'), authentication: { username: 'Service', password: 'secret' } }; } }; }
        if (name === 'node:child_process') { return { spawn: (exe: string, args: string[], options: { windowsHide: boolean }) => {
            launches.push({ executable: exe, args: [...args], windowsHide: options.windowsHide }); const child = Object.assign(new EventEmitter(), { unref() {} });
            setImmediate(async () => {
                child.emit('spawn');
                if (args.includes('/C')) {
                    const file = args[args.indexOf('/C') + 1].slice('KOTMxlViewer='.length);
                    const request = JSON.parse(await fs.readFile(file, 'utf8'));
                    if (failure !== undefined) { await fs.writeFile(args[args.indexOf('/Out') + 1], failure, 'utf16le'); child.emit('exit', 1, null); return; }
                    assert.equal(request.filePath, document.fsPath); await fs.writeFile(request.resultPath, '{"opened":true}');
                }
            }); return child;
        } }; }
        return require(name);
    };
    const sharedPlatform = loadSharedStartupPlatform(requireDependency);
    vm.runInNewContext(ts.transpileModule(await fs.readFile('src/mxlFileOpener.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, { module, exports: module.exports, process: { platform: 'win32' }, setTimeout, require: requireDependency });
    const open = module.exports.createScenarioFileOpener({ extensionUri: toUri(root) }, session);
    return { open, document, executable, external, launches, vanessa, session, progress, prepared: () => prepared, fail: (text: string) => { failure = '\uFEFF' + text; },
        resolved, observedBases, preparedPlatforms, running: (exe: string) => { runningPlatform = exe; }, discoveryFailure: (error: unknown) => { discoveryError = error; },
        mode: (value: string) => { mode = value; }, trust: (value: boolean) => { trusted = value; }, noPlatform: () => { selected = false; } };
}

test('File Workshop receives the exact MXL filename, while other file types keep the OS association', async t => {
    const h = await fixture(t); assert.equal(await h.open(h.document), true);
    assert.equal(h.launches[0].executable, h.executable); assert.deepEqual(h.launches[0].args, [h.document.fsPath]);
    assert.equal(h.launches[0].windowsHide, false);
    const other = { ...h.document, fsPath: h.document.fsPath + '.txt' }; await h.open(other);
    assert.deepEqual(h.external, [other.fsPath]); assert.equal(h.prepared(), 0);
});

test('the platform preference uses the connected Vanessa and does not start another infobase when it is busy', async t => {
    const h = await fixture(t); h.mode('platform'); h.session.snapshot.capabilities = { mxlOpen: { supported: true } };
    assert.equal(await h.open(h.document), true); assert.deepEqual(h.vanessa, [h.document.fsPath]);
    h.session.openMxlFile = async () => { throw new Error('Vanessa is busy'); };
    await assert.rejects(h.open(h.document), /Vanessa is busy/u); assert.equal(h.prepared(), 0); assert.equal(h.launches.length, 0);
});

test('without Vanessa the platform preference starts the bundled viewer in the service IB and waits for its result', async t => {
    const h = await fixture(t); h.mode('platform'); assert.equal(await h.open(h.document), true);
    assert.equal(h.prepared(), 1); assert.equal(h.vanessa.length, 0); assert.equal(h.launches[0].executable, '1cv8c.exe');
    assert.equal(h.launches[0].windowsHide, false);
    assert.ok(h.launches[0].args.some(value => value.endsWith('KOTMxlViewer.epf')));
    assert.equal(h.launches[0].args[h.launches[0].args.indexOf('/N') + 1], 'Service');
    assert.equal((h.resolved[0] as { promptUser: boolean }).promptUser, false);
});

test('MXL reuses the running service-IB platform for preparation and launch without requesting a platform', async t => {
    const h = await fixture(t); h.mode('platform'); const exe = 'C:\\Program Files\\1cv8\\8.5.1.1522\\bin\\1cv8c.exe'; h.running(exe);
    assert.equal(await h.open(h.document), true);
    assert.equal(h.observedBases.length, 1); assert.ok(h.observedBases[0].endsWith(path.sep + 'ib'));
    assert.deepEqual(h.preparedPlatforms, [exe]); assert.equal(h.launches[0].executable, exe); assert.equal(h.resolved.length, 0);
});

test('unknown or conflicting service-IB platforms prevent preparation and launch with the default version', async t => {
    const h = await fixture(t); h.mode('platform'); h.discoveryFailure(new OneCInfobasePlatformError('conflict'));
    await assert.rejects(h.open(h.document), /Several 1C platforms/u);
    h.discoveryFailure(new Error('process query denied'));
    await assert.rejects(h.open(h.document), /Could not determine the platform/u);
    assert.equal(h.prepared(), 0); assert.equal(h.launches.length, 0); assert.equal(h.resolved.length, 0);
});

test('a connected Vanessa without MXL support explains the fallback, and a failed 1C process reports its log immediately', async t => {
    const h = await fixture(t); h.mode('platform'); h.session.snapshot.capabilities = { mxlOpen: { supported: false } };
    h.fail('Нет свободной лицензии\nPassword=hidden-secret');
    await assert.rejects(h.open(h.document), (error: Error) => {
        assert.match(error.message, /1C closed before opening.*exit: 1/u);
        assert.match(error.message, /Нет свободной лицензии/u); assert.match(error.message, /launch\.log/u);
        assert.ok(!error.message.includes('hidden-secret')); return true;
    });
    assert.ok(h.progress.some(text => text.includes('Vanessa cannot open MXL through its API')));
    assert.equal(h.vanessa.length, 0);
});

test('a missing default platform starts nothing, and untrusted MXL files do not launch configured executables', async t => {
    const h = await fixture(t); h.mode('platform'); h.noPlatform(); assert.equal(await h.open(h.document), false);
    assert.equal(h.prepared(), 0); assert.equal(h.launches.length, 0);
    h.trust(false); await assert.rejects(h.open(h.document), /Trust the workspace/u);
});
