import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

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
