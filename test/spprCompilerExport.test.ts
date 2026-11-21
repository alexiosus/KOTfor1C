import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildDirectSpawnCommand, runDirectProcess } from '../src/directProcessLaunch';
import { exportSpprCompiler, SPPR_COMPILER_NAME as name, type SpprCompilerExportDependencies } from '../src/spprCompilerExport';

async function fixture(mode: 'success' | 'failed' | 'cancelled' | 'missing' | 'invalid' = 'success') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-compiler-test-'));
    const destination = path.join(directory, 'build', 'compiler.epf'); await fs.mkdir(path.dirname(destination)); await fs.writeFile(destination, 'previous compiler');
    const lists: string[][] = []; const commands: string[][] = []; const phases: string[] = []; let preparations = 0;
    const dependencies: SpprCompilerExportDependencies = {
        progress: phase => { phases.push(phase); },
        prepareBuild: async () => { preparations++; return { executable: 'service-designer', args: ['DESIGNER', '/F', 'service-ib'] }; },
        run: async (command, cwd) => {
            const args = command.args; commands.push(args);
            if (args.includes('/DumpConfigToFiles')) {
                lists.push((await fs.readFile(args[args.indexOf('-listFile') + 1], 'utf8')).replace(/^\uFEFF/u, '').trim().split(/\r?\n/u));
                assert.equal(command.executable, 'source-designer');
            } else if (args.includes('Inspect')) {
                const children = mode === 'invalid' ? ['DataProcessor.Other.Form.Unrelated'] : [`DataProcessor.${name}.Form.Форма`, `DataProcessor.${name}.Template.Макет`];
                await fs.writeFile(args[args.indexOf('-Manifest') + 1], JSON.stringify(children));
            } else if (args.includes('/LoadExternalDataProcessorOrReportFromFiles')) {
                assert.equal(command.executable, 'service-designer');
                if (mode === 'failed') { await fs.writeFile(args[args.indexOf('/Out') + 1], 'Build failed\npassword=secret'); return { exitCode: 1, stdout: '', stderr: '', cancelled: false }; }
                if (mode === 'cancelled') { return { exitCode: -1, stdout: '', stderr: '', cancelled: true }; }
                if (mode !== 'missing') { await fs.writeFile(args[args.indexOf('/LoadExternalDataProcessorOrReportFromFiles') + 2], 'new compiler'); }
            }
            assert.equal(cwd.startsWith(directory), true);
            return { exitCode: 0, stdout: '', stderr: '', cancelled: false };
        }
    };
    const run = () => exportSpprCompiler({ source: { executable: 'source-designer', args: ['DESIGNER', '/F', 'source-ib'] },
        destination, jobsDirectory: path.join(directory, 'jobs'), converterScript: 'converter.ps1', powershell: 'powershell' }, dependencies, { isCancellationRequested: false });
    return { directory, destination, lists, commands, phases, preparations: () => preparations, run,
        cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

test('export reads the compiler and all its forms/templates, builds separately and atomically replaces the EPF', async () => {
    const h = await fixture();
    try {
        assert.equal(await h.run(), h.destination);
        assert.deepEqual(h.lists, [[`DataProcessor.${name}`], [`DataProcessor.${name}`, `DataProcessor.${name}.Form.Форма`, `DataProcessor.${name}.Template.Макет`]]);
        assert.deepEqual(h.phases, ['reading', 'converting', 'preparing', 'building']);
        assert.equal(await fs.readFile(h.destination, 'utf8'), 'new compiler');
        assert.equal(h.commands.some(args => args.some(arg => /UpdateDBCfg|LoadConfigFromFiles|RestoreIB/iu.test(arg))), false);
        assert.deepEqual(await fs.readdir(path.join(h.directory, 'jobs')), []);
        assert.deepEqual(await fs.readdir(path.dirname(h.destination)), ['compiler.epf']);
    } finally { await h.cleanup(); }
});

for (const mode of ['failed', 'cancelled', 'missing', 'invalid'] as const) {
    test(`${mode} export preserves the previous compiler and removes its own temporary files`, async () => {
        const h = await fixture(mode);
        try {
            await assert.rejects(h.run(), error => {
                assert.ok(error instanceof Error); assert.ok(!error.message.includes('secret'));
                if (mode === 'cancelled') { assert.equal(error.name, 'AbortError'); }
                return true;
            });
            assert.equal(await fs.readFile(h.destination, 'utf8'), 'previous compiler');
            assert.deepEqual(await fs.readdir(path.join(h.directory, 'jobs')), []);
            assert.deepEqual(await fs.readdir(path.dirname(h.destination)), ['compiler.epf']);
            if (mode === 'invalid') { assert.equal(h.preparations(), 0); }
        } finally { await h.cleanup(); }
    });
}

test('the packaged XML converter preserves custom BSL and forms, changes only self metadata references', { skip: process.platform !== 'win32' }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-compiler-xml-test-'));
    try {
        const source = path.join(directory, 'source'); const external = path.join(directory, 'external');
        const root = path.join(source, 'DataProcessors', name); await fs.mkdir(path.join(root, 'Ext'), { recursive: true }); await fs.mkdir(external);
        const xml = `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable"><DataProcessor uuid="source-id"><InternalInfo><xr:GeneratedType name="DataProcessorObject.${name}" category="Object"/><xr:GeneratedType name="DataProcessorManager.${name}" category="Manager"/></InternalInfo><Properties><Name>${name}</Name><Synonym/><Comment>custom compiler</Comment><UseStandardCommands>true</UseStandardCommands><DefaultForm>DataProcessor.${name}.Form.Форма</DefaultForm><AuxiliaryForm/></Properties><ChildObjects><Form>Форма</Form><Template>Макет</Template><Attribute uuid="attribute-id"><Properties><Name>Custom</Name></Properties></Attribute></ChildObjects></DataProcessor></MetaDataObject>`;
        await fs.writeFile(root + '.xml', xml);
        const module = Buffer.from('\uFEFF// Доработка СППР\r\nПроцедура Собрать() Экспорт\r\n Сообщить("DataProcessor.' + name + '");\r\nКонецПроцедуры');
        await fs.writeFile(path.join(root, 'Ext', 'ObjectModule.bsl'), module); await fs.writeFile(path.join(root, 'Ext', 'ManagerModule.bsl'), '// manager');
        for (const kind of ['Forms', 'Templates']) {
            const child = kind === 'Forms' ? 'Форма' : 'Макет'; await fs.mkdir(path.join(root, kind, child, 'Ext'), { recursive: true });
            await fs.writeFile(path.join(root, kind, child + '.xml'), '<Child/>');
            await fs.writeFile(path.join(root, kind, child, 'Ext', 'content.xml'), `<Type>cfg:DataProcessorObject.${name}</Type>`);
        }
        const manifest = path.join(directory, 'manifest.json');
        for (const mode of ['Inspect', 'Convert']) {
            const result = await runDirectProcess(buildDirectSpawnCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-File', path.resolve('tools/sppr-compiler/convert.ps1'), '-Mode', mode, '-SourceDirectory', source, '-ExternalDirectory', external, '-Manifest', manifest, '-Name', name]));
            assert.equal(result.exitCode, 0, result.stderr);
        }
        assert.deepEqual(JSON.parse(await fs.readFile(manifest, 'utf8')), [`DataProcessor.${name}.Form.Форма`, `DataProcessor.${name}.Template.Макет`]);
        const converted = await fs.readFile(path.join(external, name + '.xml'), 'utf8');
        assert.match(converted, /<ExternalDataProcessor/u); assert.match(converted, /<xr:ContainedObject>/u);
        assert.ok(converted.includes(`ExternalDataProcessor.${name}.Form.Форма`)); assert.ok(!converted.includes('category="Manager"'));
        assert.ok(!converted.includes('UseStandardCommands')); assert.match(converted, /attribute-id/u);
        assert.deepEqual(await fs.readFile(path.join(external, name, 'Ext', 'ObjectModule.bsl')), module);
        assert.equal(await fs.readFile(root + '.xml', 'utf8'), xml);
        assert.equal(await fs.stat(path.join(external, name, 'Ext', 'ManagerModule.bsl')).then(() => true, () => false), false);
        for (const kind of ['Forms', 'Templates']) {
            const child = kind === 'Forms' ? 'Форма' : 'Макет';
            assert.equal(await fs.readFile(path.join(external, name, kind, child, 'Ext', 'content.xml'), 'utf8'), `<Type>cfg:ExternalDataProcessorObject.${name}</Type>`);
        }
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
