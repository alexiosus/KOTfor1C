import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { collectTreeWithConcurrencyLimit, mapWithConcurrencyLimit } from '../src/boundedConcurrency';
import { buildScenarioCatalog } from '../src/scenarioCatalog';
import * as descriptors from '../src/scenarioDescriptor';
import { loadProjectScenarioMetadata, resolveProjectLibraryRoot } from '../src/projectLibraryMetadata';
import { ProjectLibraryStore } from '../src/projectLibraryStore';

test('scanner discovers named compiler YAML descriptors and skips settings and unsupported extensions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-process-scan-'));
    const processRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-separate-process-root-'));
    try {
        fs.writeFileSync(path.join(processRoot, 'other.yaml'), 'ТипФайла: "Процесс"\nДанныеПроцесса:\n  Имя: "Separate process"\n  UID: "separate"\n');
        fs.writeFileSync(path.join(root, 'order.yaml'), 'ДанныеСценария:\n    Имя: "Order"\n    UID: "order"\n');
        fs.writeFileSync(path.join(root, 'nested.yaml'), 'ДанныеСценария:\n    Имя: "Nested"\n    UID: "nested"\n');
        fs.mkdirSync(path.join(root, 'test'));
        fs.writeFileSync(path.join(root, 'test', 'custom-settings.yaml'), 'ТипФайла: "НастройкаТеста"\nДанныеТеста:\n    UIDСценария: "ORDER"\n');
        fs.writeFileSync(path.join(processRoot, 'foreign-settings.yaml'), 'ТипФайла: "НастройкаТеста"\nДанныеТеста:\n    UIDСценария: "nested"\n');
        fs.writeFileSync(path.join(root, 'process.yaml'), 'ТипФайла: "Процесс"\nДанныеПроцесса:\n    Имя: "Sales"\n    UID: "sales"\n');
        fs.writeFileSync(path.join(root, 'settings.yaml'), 'ТипФайла: "НастройкаПроцесса"\nДанныеТеста:\n    Имя: "Sales settings"\n');
        fs.writeFileSync(path.join(root, 'config.yaml'), 'Имя: "Configuration"\n');
        fs.writeFileSync(path.join(root, 'unsupported.yml'), 'ДанныеСценария:\n    Имя: "Ignored"\n');
        fs.mkdirSync(path.join(root, 'native'));
        const nativeMetadata = 'ТипФайла: "Сценарий"\nДанныеСценария:\n    Имя: "Native"\n    UID: "native"\n';
        fs.writeFileSync(path.join(root, 'native', 'meta.yaml'), nativeMetadata);
        fs.writeFileSync(path.join(root, 'native', 'orig.yaml'), nativeMetadata);
        fs.writeFileSync(path.join(root, 'native', 'scen.feature'), 'And original SPPR script\n');
        const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
        const compiled = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src', 'workspaceScanner.ts'), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText;
        const makeUri = (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => `file://${fsPath}` });
        const moduleObject = { exports: {} as Record<string, unknown> };
        vm.runInNewContext(compiled, {
            module: moduleObject, exports: moduleObject.exports, Buffer, process, performance, console,
            require: (specifier: string) => {
                switch (specifier) {
                    case 'vscode': return {
                        Uri: { file: makeUri },
                        workspace: { asRelativePath: () => 'outside', fs: { readFile: async (uri: ReturnType<typeof makeUri>) => fs.promises.readFile(uri.fsPath) } },
                        CancellationError: class extends Error {}
                    };
                    case 'fs': return fs;
                    case 'path': return path;
                    case './boundedConcurrency': return { collectTreeWithConcurrencyLimit, mapWithConcurrencyLimit };
                    case './scenarioCatalog': return { buildScenarioCatalog };
                    case './scenarioScanRoot': return { resolveScenarioScanRootFsPath: () => root, resolveProcessScanRootFsPath: () => processRoot, getScenarioScanRootPath: () => root };
                    case './scenarioDescriptor': return descriptors;
                    case './projectLibraryMetadata': return { loadProjectScenarioMetadata, resolveProjectLibraryRoot };
                    case './projectLibraryIntegration': return { loadSingleProjectScenario: async (info: unknown) => info };
                    default: throw new Error(`Unexpected dependency: ${specifier}`);
                }
            }
        });
        const scan = moduleObject.exports.scanWorkspaceForScenarioCatalog as
            (uri: ReturnType<typeof makeUri>) => Promise<ReturnType<typeof buildScenarioCatalog>>;
        const catalog = await scan(makeUri(root));
        assert.deepEqual(catalog.all.map(item => item.name).sort(), ['Native', 'Nested', 'Order', 'Sales', 'Separate process']);
        assert.equal(catalog.byName.get('Native')?.[0].yamlFileUri.fsPath, path.join(root, 'native', 'meta.yaml'));
        assert.equal(catalog.byName.get('Native')?.length, 1);
        assert.equal(catalog.byName.get('Order')?.[0].tabName, 'Ungrouped');
        assert.equal(catalog.byName.get('Nested')?.[0].tabName, undefined);
        assert.equal(catalog.byName.get('Sales')?.[0].tabName, 'Ungrouped');
        assert.equal(catalog.byName.get('Sales')?.[0].kind, 'process');
        assert.equal(catalog.byName.get('Sales')?.[0].yamlFileUri.fsPath, path.join(root, 'process.yaml'));
        assert.equal(fs.existsSync(path.join(root, '.kot', 'groups.yml')), true);
        assert.equal(fs.existsSync(path.join(processRoot, '.kot', 'groups.yml')), true);
        assert.deepEqual(await new ProjectLibraryStore(root).readGroups(), []);
        assert.deepEqual(await new ProjectLibraryStore(processRoot).readGroups(), []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(processRoot, { recursive: true, force: true });
    }
});
