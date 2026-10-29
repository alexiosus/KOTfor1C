import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parseCompilerSourceMap, findCompilerSourceLocation } from '../src/compilerArtifacts';
import { getCompilerScenarioBody } from '../src/scenarioCompilerSyntax';

test('Create picker routes the process choice to its creation command', async () => {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src/extension.ts'), 'utf8');
    const ast = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.ES2022, true);
    let callback: string | undefined;
    const visit = (node: import('typescript').Node) => {
        if (ts.isCallExpression(node) && node.arguments.length >= 2 && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'kotTestToolkit.showCreateScenarioMenu') {
            callback = node.arguments[1].getText(ast);
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.ok(callback);
    const compiled = ts.transpileModule(`module.exports = ${callback};`, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const executed: string[] = [];
    const moduleObject = { exports: undefined as unknown };
    vm.runInNewContext(compiled, {
        module: moduleObject, context: { extensionUri: '/extension' },
        getTranslator: async () => (message: string) => message,
        vscode: {
            window: { showQuickPick: async (items: Array<{ command: string }>) => items.find(item => item.command === 'kotTestToolkit.createProcess') },
            commands: { executeCommand: async (command: string) => executed.push(command) }
        }
    });
    await (moduleObject.exports as () => Promise<void>)();
    assert.deepEqual(executed, ['kotTestToolkit.createProcess']);
});

test('process commands are contributed and exposed from the creation and YAML editor menus', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const english = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.nls.json'), 'utf8'));
    const russian = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.nls.ru.json'), 'utf8'));
    for (const command of ['kotTestToolkit.createProcess', 'kotTestToolkit.editProcessSteps', 'kotTestToolkit.addProcessSteps']) {
        const contribution = manifest.contributes.commands.find((item: { command: string }) => item.command === command);
        assert.ok(contribution);
        const key = contribution.title.slice(1, -1);
        assert.ok(english[key]);
        assert.ok(russian[key]);
    }
    assert.ok(manifest.contributes.menus['kotTestToolkit.phaseSwitcher.create'].some((item: { command: string }) => item.command === 'kotTestToolkit.createProcess'));
    assert.ok(manifest.contributes.menus['kotTestToolkit.editorContext.editing'].some((item: { command: string }) => item.command === 'kotTestToolkit.editorMenu.editProcessSteps'));
});

test('feature source navigation uses the compiler map before the name-based fallback', async () => {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src/extension.ts'), 'utf8');
    const ast = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.ES2022, true);
    let callback: string | undefined;
    const visit = (node: import('typescript').Node) => {
        if (ts.isCallExpression(node) && node.arguments.length >= 2 && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'kotTestToolkit.openNestedScenarioFromFeature') {
            callback = node.arguments[1].getText(ast);
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.ok(callback);
    const compiled = ts.transpileModule(`module.exports = ${callback};`, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    let mapped = true;
    const visits: string[] = [];
    const editor = { source: 'compiled.feature' };
    const moduleObject = { exports: undefined as unknown };
    vm.runInNewContext(compiled, {
        module: moduleObject, projectDefinitionResolver: {},
        phaseSwitcherProvider: { openCompilerSourceFromFeatureEditor: async (received: unknown) => {
            assert.equal(received, editor); visits.push('map'); return mapped;
        } },
        openNestedScenarioFromFeatureHandler: async () => { visits.push('fallback'); }
    });
    const command = moduleObject.exports as (editor: unknown, edit: unknown) => Promise<void>;
    await command(editor, {});
    assert.deepEqual(visits, ['map']);
    mapped = false;
    visits.length = 0;
    await command(editor, {});
    assert.deepEqual(visits, ['map', 'fallback']);
});

function loadCompilerSourceLookup() {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync('src/phaseSwitcher.ts', 'utf8');
    const ast = ts.createSourceFile('phaseSwitcher.ts', source, ts.ScriptTarget.ES2022, true);
    let method: string | undefined;
    const visit = (node: import('typescript').Node) => {
        if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'resolveCompilerSourceFromFeature') {
            method = node.getText(ast);
        }
        ts.forEachChild(node, visit);
    };
    visit(ast);
    assert.ok(method);
    const yaml = 'ТипФайла: Сценарий\nТекстСценария: |\n    And Delay "1"\n    And Delay "2"\n';
    const opened: string[] = [];
    const uri = (file: string) => ({ scheme: 'file', fsPath: file, toString: () => 'file://' + file });
    let mapText = JSON.stringify({ ДанныеСценария: [{ UIDСценария: 'source-uid', СтрокаЛин: 12, СтрокаОриг: 2 }] });
    const moduleObject = { exports: undefined as any };
    vm.runInNewContext(ts.transpileModule(`module.exports = class { ${method} };`, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, {
        module: moduleObject, path, parseCompilerSourceMap, findCompilerSourceLocation, getCompilerScenarioBody,
        fs: { promises: { readFile: async (file: string) => {
            assert.equal(file, '/repo/built.str');
            return mapText;
        } } },
        vscode: {
            Location: class { constructor(public uri: unknown, public range: unknown) {} },
            workspace: { openTextDocument: async (resource: { fsPath: string }) => {
                opened.push(resource.fsPath);
                return { uri: resource, getText: () => yaml, lineAt: (line: number) => ({ range: { start: { line, character: 0 }, end: { line, character: 20 } } }) };
            } },
            window: { showTextDocument: () => assert.fail('Definition lookup must not show editors') }
        },
        require: (name: string) => {
            assert.equal(name, './spprScenarioFiles.js');
            return { resolveScenarioSourceUris: async () => ({ scriptUri: uri('/repo/scen.feature') }), readScenarioSource: async () => yaml };
        }
    });
    const lookup = new moduleObject.exports().resolveCompilerSourceFromFeature;
    return { uri, opened, lookup: (files: string[], token = { isCancellationRequested: false }) => lookup.call({
        getScenarioCatalog: () => ({ all: files.map(file => ({ uid: 'SOURCE-UID', yamlFileUri: uri(file) })) })
    }, uri('/repo/built.feature'), 12, token), setMap: (text: string) => { mapText = text; } };
}

test('compiler definition lookup maps YAML and paired feature rows without showing editors', async () => {
    const harness = loadCompilerSourceLookup();
    const legacy = await harness.lookup(['/repo/scen.yaml']);
    assert.equal(legacy.uri.fsPath, '/repo/scen.yaml');
    assert.equal(legacy.range.start.line, 3);
    const native = await harness.lookup(['/repo/meta.yaml']);
    assert.equal(native.uri.fsPath, '/repo/scen.feature');
    assert.equal(native.range.start.line, 1);
    assert.deepEqual(harness.opened, ['/repo/scen.yaml', '/repo/scen.feature']);
});

test('compiler definition lookup rejects missing, ambiguous and cancelled source mappings', async () => {
    const harness = loadCompilerSourceLookup();
    assert.equal(await harness.lookup([]), null);
    assert.equal(await harness.lookup(['/repo/a.yaml', '/repo/b.yaml']), null);
    assert.equal(await harness.lookup(['/repo/scen.yaml'], { isCancellationRequested: true }), null);
    harness.setMap('not JSON');
    assert.equal(await harness.lookup(['/repo/scen.yaml']), null);
    harness.setMap(JSON.stringify({ ДанныеСценария: [{ UIDСценария: 'source-uid', СтрокаЛин: 12, СтрокаОриг: 300 }] }));
    assert.equal(await harness.lookup(['/repo/scen.yaml']), null);
});
