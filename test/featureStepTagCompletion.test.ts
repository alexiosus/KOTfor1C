import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as featureActions from '../src/featureEditorActions';
import * as featureTags from '../src/featureTags';
import * as keywords from '../src/gherkinDefinitionKeywords';
import * as scenarioYaml from '../src/scenarioYamlDocument';

class Range {
    readonly start: { line: number; character: number };
    readonly end: { line: number; character: number };
    constructor(start: number | { line: number; character: number }, characterOrEnd: number | { line: number; character: number }, end?: number, endCharacter?: number) {
        this.start = typeof start === 'number' ? { line: start, character: characterOrEnd as number } : start;
        this.end = typeof characterOrEnd === 'number' ? { line: end!, character: endCharacter! } : characterOrEnd;
    }
}

function harness(text: string, fileName = 'order.feature', projectTags: readonly string[] = [], loadTags?: () => Promise<readonly string[]>) {
    const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
    const uri = { scheme: 'file', toString: () => `file:///tests/${fileName}` };
    const document = {
        uri, version: 3, text,
        get lineCount() { return this.text.split(/\r?\n/u).length; },
        lineAt(line: number) { return { text: this.text.split(/\r?\n/u)[line] }; },
        getText() { return this.text; },
        positionAt(offset: number) {
            const lines = this.text.slice(0, offset).split(/\r?\n/u);
            return { line: lines.length - 1, character: lines.at(-1)!.length };
        }
    };
    const offsetAt = (position: { line: number; character: number }) => {
        const lines = document.text.split(/\r?\n/u);
        const eol = document.text.includes('\r\n') ? 2 : 1;
        return lines.slice(0, position.line).reduce((offset, line) => offset + line.length + eol, 0) + position.character;
    };
    const prompts: string[] = []; const errors: string[] = [];
    let cancel = false; let changeDuringPrompt = false;
    const editor = { document, async insertSnippet(snippet: { value: string }, range: Range) {
        document.text = document.text.slice(0, offsetAt(range.start)) + snippet.value + document.text.slice(offsetAt(range.end));
        document.version++; return true;
    } };
    const host = {
        Range,
        CodeLens: class { constructor(public range: Range, public command: unknown) {} },
        CodeAction: class { constructor(public title: string, public kind: unknown) {} },
        CodeActionKind: { RefactorRewrite: 'refactor.rewrite' },
        CompletionItem: class { constructor(public label: string, public kind: number) {} },
        CompletionItemKind: { Keyword: 14 }, CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 },
        SnippetString: class { constructor(public value: string) {} }, Uri: { parse: () => uri },
        l10n: { t: (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/gu, (_match, index: string) => args[Number(index)] ?? '') },
        workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }), openTextDocument: async () => document },
        window: { showTextDocument: async () => editor, showErrorMessage: (message: string) => errors.push(message),
            showQuickPick: async (items: { label: string }[], options: { title: string }) => {
                prompts.push(options.title);
                if (changeDuringPrompt) { document.version++; }
                return cancel ? undefined : items.find(item => item.label === '@screenshot') ?? items[0];
            } }
    };
    const dependencies: Record<string, unknown> = { vscode: host, './featureEditorActions': featureActions, './featureTags': featureTags, './gherkinDefinitionKeywords': keywords, './scenarioYamlDocument': scenarioYaml };
    const load = (file: string) => {
        const moduleObject = { exports: {} as Record<string, any> };
        vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src', file), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText, { module: moduleObject, exports: moduleObject.exports, require: (specifier: string) => dependencies[specifier], console, Buffer });
        return moduleObject.exports;
    };
    dependencies['./gherkinLanguage'] = load('gherkinLanguage.ts');
    dependencies['./localization'] = load('localization.ts');
    if (fs.existsSync(path.join(process.cwd(), 'src/gherkinAnnotations.ts'))) { dependencies['./gherkinAnnotations'] = load('gherkinAnnotations.ts'); }
    const api = load('featureEditorCodeLens.ts');
    const complete = async (line: number, character: number, triggerKind = 0) => {
        assert.equal(typeof api.FeatureStepTagCompletionProvider, 'function', 'step tags have a native IntelliSense provider');
        return new api.FeatureStepTagCompletionProvider(uri, { getTags: loadTags ?? (async () => projectTags) }).provideCompletionItems(document, { line, character }, { isCancellationRequested: false }, { triggerKind, triggerCharacter: triggerKind === 1 ? '@' : undefined });
    };
    const accept = (item: { range: Range; insertText: string }) => {
        document.text = document.text.slice(0, offsetAt(item.range.start)) + item.insertText + document.text.slice(offsetAt(item.range.end));
    };
    return { api, document, uri, complete, accept, prompts, errors, setCancel() { cancel = true; }, setChangeDuringPrompt() { changeDuringPrompt = true; } };
}

test('typing @ before a nested step completes tags without doubling @ or indentation', async () => {
    const h = harness('Feature: Order\nScenario: Ready\n    * Group\n        @\n        Given ready\n');
    const items = await h.complete(3, 9, 1);
    assert.deepEqual(Array.from(items, (item: any) => item.label), ['@screenshot', '@recordvideo', '@StopRecordVideo', '@StartRecordVideo']);
    h.accept(items[0]);
    assert.equal(h.document.text, 'Feature: Order\nScenario: Ready\n    * Group\n        @screenshot\n        Given ready\n');
});

test('feature and scenario headers offer project tags without duplicates or step-only annotations', async () => {
    const h = harness('@tree\n@Smoke @\nFeature: Order\n\n@Smoke\n@\nScenario: Ready\n    Given ready\n', 'order.feature', ['@Smoke', '@team.sales', '@issue=123']);
    const featureItems = await h.complete(1, 8, 1);
    const labels = Array.from(featureItems, (item: any) => item.label);
    assert.ok(labels.includes('@ExportScenarios'));
    assert.ok(labels.includes('@Draft'));
    assert.ok(labels.includes('@team.sales'));
    assert.equal(labels.includes('@tree'), false);
    assert.equal(labels.includes('@Smoke'), false);
    assert.equal(labels.includes('@screenshot'), false);
    h.accept(featureItems.find((item: any) => item.label === '@team.sales'));
    assert.ok(h.document.text.startsWith('@tree\n@Smoke @team.sales\nFeature: Order'));
    const scenarioItems = await h.complete(5, 1, 1);
    assert.ok(scenarioItems.some((item: any) => item.label === '@issue=123'));
    assert.equal(scenarioItems.some((item: any) => item.label === '@tree'), false);
});

test('project tags remain available when all built-in header tags have already been used', async () => {
    const h = harness('@tree @ExportScenarios @Draft\n@\nFeature: Order\nScenario: Ready\n    Given ready', 'order.feature', ['@Regression']);
    assert.ok((await h.complete(1, 1, 1)).some((item: any) => item.label === '@Regression'));
});

test('blank lines and annotations at the end of a scenario support new step annotations in feature and YAML', async () => {
    for (const [text, file] of [['Feature: Order\nScenario: Ready\n    Given ready\n    @', 'order.feature'], ['ТипФайла: Сценарий\nТекстСценария: |\n  И готово\n  @', 'scen.yaml']]) {
        const h = harness(text, file);
        const line = text.split('\n').length - 1;
        const items = await h.complete(line, text.split('\n').at(-1)!.length, 1);
        assert.ok(items.some((item: any) => item.label === '@screenshot'));
        assert.equal(items.some((item: any) => item.label === '@ExportScenarios'), false);
    }
});

test('manual annotation insertion on a blank YAML line keeps it inside the scenario block', async () => {
    const h = harness('ТипФайла: Сценарий\nТекстСценария: |\n  И готово\n\nПараметрыСценария:\n  Имя: Значение', 'scen.yaml');
    const items = await h.complete(3, 0);
    h.accept(items.find((item: any) => item.label === '@screenshot'));
    assert.ok(h.document.text.includes('  И готово\n  @screenshot\nПараметрыСценария:'));
});

test('annotation completions do not leak into indented scenario argument slots', async () => {
    for (const tail of ['', '\n  And next']) {
        for (const slot of ['    ', '    @', '    Value = "@"']) {
            const text = `ТипФайла: Сценарий\nТекстСценария: |\n  Given Child\n    First = 'one'\n${slot}${tail}`;
            const h = harness(text, 'scen.yaml');
            assert.equal((await h.complete(4, slot.length)).length, 0, text);
        }
    }
});

test('asynchronous project tag loading does not return ranges for a changed document', async () => {
    let h: ReturnType<typeof harness>;
    h = harness('@\nFeature: Order\n', 'order.feature', [], async () => { h.document.text = 'Feature: Changed\n'; h.document.version++; return ['@Stale']; });
    assert.equal((await h.complete(0, 1, 1)).length, 0);
});

test('YAML step IntelliSense inserts annotations in the block without changing metadata, indentation or CRLF', async () => {
    const initial = '\uFEFF#language: ru\r\nТипФайла: Сценарий\r\nТекстСценария: |2-\r\n  * Группа\r\n    И готово "$Value}"\r\nПараметрыСценария:\r\n  Имя: Значение\r\n';
    const h = harness(initial, 'scen.yaml');
    const items = await h.complete(4, 10);
    assert.ok(items.some((item: any) => item.label === '@screenshot'));
    assert.ok(items.some((item: any) => item.label === '#[autodoc.mute]'));
    assert.equal(items.some((item: any) => item.label === '@ExportScenarios'), false);
    h.accept(items.find((item: any) => item.label === '@screenshot'));
    assert.equal(h.document.text, initial.replace('    И готово', '    @screenshot\r\n    И готово'));
    assert.equal((await h.complete(7, 5)).length, 0);
    const actions = new h.api.FeatureStepTagCodeActionProvider().provideCodeActions(h.document, new Range(5, 8, 5, 8));
    const startVideo = actions.find((action: any) => action.title === '+ @StartRecordVideo');
    assert.ok(startVideo, 'step lightbulb also supports YAML');
    await h.api.editFeatureStructureCommand(startVideo.command.arguments[0], (message: string) => message, startVideo.command.arguments[1]);
    assert.ok(h.document.text.includes('    @screenshot\r\n    @StartRecordVideo\r\n    И готово'));
});

test('autodoc directives have context-specific snippets and can be completed after a partial # token', async () => {
    const h = harness('Feature: Order\nScenario: Ready\n    #[autodoc.ig\n    * Group\n        Given ready\n');
    const items = await h.complete(2, 16, 1);
    assert.ok(items.some((item: any) => item.label === '#[autodoc.ignorestep]'));
    assert.ok(items.some((item: any) => item.label === '#[autodoc.groupsteps]'));
    assert.equal(items.some((item: any) => item.label === '@screenshot'), false);
    h.accept(items.find((item: any) => item.label === '#[autodoc.ignorestep]'));
    assert.equal(h.document.text, 'Feature: Order\nScenario: Ready\n    #[autodoc.ignorestep]\n    * Group\n        Given ready\n');
    const text = (await h.complete(4, 10)).find((item: any) => item.label === '#[autodoc.text]');
    assert.ok(text.insertText instanceof Object);
    assert.match(text.insertText.value, /\$\{1:Step text\}/u);
    assert.match(text.documentation, /text/i);
    const feature = harness('@\nFeature: Order\n@\nScenario: Ready\n    Given ready');
    const beforeFeature = await feature.complete(0, 1);
    assert.ok(beforeFeature.some((item: any) => item.label === '#[autodoc.ignore.featureslide]'));
    assert.ok(beforeFeature.some((item: any) => item.label === '#[autodoc.ignore.finalslide]'));
    const beforeScenario = await feature.complete(2, 1);
    assert.ok(beforeScenario.some((item: any) => item.label === '#[autodoc.ignore.scenarioslide]'));
    assert.equal(beforeScenario.some((item: any) => item.label === '#[autodoc.ignore.featureslide]'), false);
});

test('partial directive completion at a BOM header preserves the BOM and offers only directives', async () => {
    const h = harness('\uFEFF#[autodoc.ig\nFeature: Header\nScenario: Ready\n    Given ready');
    const items = await h.complete(0, h.document.lineAt(0).text.length, 1);
    assert.ok(items.some((item: any) => item.label === '#[autodoc.ignore.featureslide]'));
    assert.ok(items.every((item: any) => item.label.startsWith('#')));
    h.accept(items.find((item: any) => item.label === '#[autodoc.ignore.finalslide]'));
    assert.ok(h.document.text.startsWith('\uFEFF#[autodoc.ignore.finalslide]\nFeature: Header'));
});

test('export metadata completion is limited to export declarations before their bodies and excludes existing aliases', async () => {
    const h = harness('#language: ru\n@ExportScenarios\nФункционал: Библиотека\nСценарий: Экспорт\n@описание: Уже есть\n@\n    И готово\n\nСценарий: Другой\n    И готово\n@\n    И следующий');
    const items = await h.complete(5, 1);
    const labels = Array.from(items, (item: any) => item.label);
    assert.ok(labels.includes('@типшага:'));
    assert.ok(labels.includes('@steptype:'));
    assert.ok(labels.includes('@примериспользования:'));
    assert.equal(labels.includes('@описание:'), false);
    assert.equal(labels.includes('@description:'), false);
    const metadata = items.find((item: any) => item.label === '@типшага:');
    assert.match(metadata.insertText.value, /^@типшага: \$\{1:Category\}$/u);
    assert.equal((await h.complete(10, 1)).some((item: any) => item.label === '@типшага:'), false);
    const ordinary = harness('Feature: Normal\nScenario: Run\n@\n    Given ready');
    assert.equal((await ordinary.complete(2, 1)).some((item: any) => item.label === '@description:'), false);
});

test('annotation suggestions never enter YAML metadata, other block scalars, tables or multiline payloads', async () => {
    const h = harness('ТипФайла: Сценарий\nKOTМетаданные:\n  Описание: |\n    @\n    Given fake\nТекстСценария: |\n  И реальный\n  """\n  @\n  И содержимое\n  """\n  | @ |\nПараметрыСценария:\n  Имя: "@"\n', 'scen.yaml');
    for (const [line, character] of [[3, 5], [4, 8], [8, 3], [9, 5], [11, 4], [13, 10]]) {
        assert.equal((await h.complete(line, character)).length, 0, `line ${line + 1} is a payload or YAML metadata`);
    }
    assert.ok((await h.complete(6, 5)).some((item: any) => item.label === '@recordvideo'));
});

test('manual IntelliSense on a step adds its tag while preserving the complete step, CRLF and tabs', async () => {
    const h = harness('#language: ru\r\nФункционал: Заказ\r\nСценарий: Готово\r\n\tИ готово "$Value}"\r\n');
    for (const character of [0, 1, 5, 19]) {
        h.document.text = '#language: ru\r\nФункционал: Заказ\r\nСценарий: Готово\r\n\tИ готово "$Value}"\r\n';
        const items = await h.complete(3, character);
        assert.equal(items.length, 8);
        assert.equal(items[0].keepWhitespace, true);
        h.accept(items[0]);
        assert.equal(h.document.text, '#language: ru\r\nФункционал: Заказ\r\nСценарий: Готово\r\n\t@screenshot\r\n\tИ готово "$Value}"\r\n');
    }
});

test('step tag completion excludes payloads and headers and does not intrude while typing an ordinary step', async () => {
    const h = harness('Feature: Order\nVariables:\n    @\n    Given variable\nScenario Outline: Ready\n    Given payload\n    """\n    @\n    Given fake\n    """\n    | value |\n    # comment\nExamples:\n    | value |\n    | 1 |\n');
    for (const [line, character] of [[2, 5], [3, 8], [7, 5], [8, 8], [10, 5], [11, 4], [13, 5]]) {
        assert.equal((await h.complete(line, character)).length, 0, `line ${line + 1} is not a tag insertion context`);
    }
    for (const line of [0, 4]) { assert.equal((await h.complete(line, 0)).some((item: any) => item.label === '@screenshot'), false); }
    assert.equal((await h.complete(5, 10, 2)).length, 0);
});

test('tag completion replaces the full partial token and omits tags already attached to the step', async () => {
    const h = harness('Feature: Order\nBackground:\n    @screenshot\n    @recordvi\n    Given ready\n');
    const items = await h.complete(3, 9);
    assert.deepEqual(Array.from(items.filter((item: any) => item.label.startsWith('@')), (item: any) => item.label), ['@recordvideo', '@StopRecordVideo', '@StartRecordVideo']);
    h.accept(items[0]);
    assert.equal(h.document.text, 'Feature: Order\nBackground:\n    @screenshot\n    @recordvideo\n    Given ready\n');
});

test('step quick actions target the current line without a step picker and cancellation or stale text leaves it unchanged', async () => {
    const initial = 'Feature: Order\nScenario: Ready\n    Given first\n    Then selected\n';
    for (const mode of ['accept', 'cancel', 'stale']) {
        const h = harness(initial);
        const actions = new h.api.FeatureStepTagCodeActionProvider().provideCodeActions(h.document, new Range(3, 8, 3, 8));
        assert.equal(actions.length, 4);
        if (mode === 'cancel') { h.setCancel(); }
        if (mode === 'stale') { h.setChangeDuringPrompt(); }
        await h.api.editFeatureStructureCommand(actions[0].command.arguments[0], (message: string) => message, { stepLine: 3 });
        assert.deepEqual(h.prompts, ['Step screenshot / video']);
        assert.equal(h.document.text, mode === 'accept' ? 'Feature: Order\nScenario: Ready\n    Given first\n    @screenshot\n    Then selected\n' : initial);
        assert.equal(h.errors.length, mode === 'stale' ? 1 : 0);
    }
});

test('IntelliSense at the end of a large feature edits only the chosen step and exposes no step picker in the header', async () => {
    const text = 'Feature: Large\n' + Array.from({ length: 1200 }, (_, index) => `Scenario: ${index}\n    Given first\n    Then final ${index}\n\n`).join('');
    const h = harness(text);
    const items = await h.complete(4799, 8);
    assert.equal(items.length, 8);
    h.accept(items[0]);
    assert.equal(h.document.text, text.replace('    Then final 1199\n', '    @screenshot\n    Then final 1199\n'));
    const lenses = await new h.api.FeatureEditorCodeLensProvider(h.uri).provideCodeLenses(h.document, { isCancellationRequested: false });
    assert.ok(lenses.every((lens: any) => lens.command.arguments[0].kind !== 'stepTag'));
    assert.deepEqual(h.prompts, []);
});
