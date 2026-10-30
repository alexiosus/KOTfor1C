import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function load() {
    const vscode = { l10n: { t: (value: string, ...args: string[]) => value.replace(/\{(\d+)\}/gu, (_m, i) => args[Number(i)]) },
        MarkdownString: class { value = ''; isTrusted: unknown; blocks: string[] = [];
            appendMarkdown(value: string) { this.value += value; return this; }
            appendText(value: string) { this.value += value; return this; }
            appendCodeblock(value: string) { this.blocks.push(value); this.value += '\n```text\n' + value + '\n```\n'; return this; } } };
    const module = { exports: {} as any }; const ts = require('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/vanessaFailureHover.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, require: () => vscode });
    return module.exports.buildVanessaFailureHover;
}

test('MCP and log errors use a scenario heading, navigation links and code blocks for details', () => {
    const hover = load()([{ scenarioName: 'Orders', failureSummary: 'Element not found',
        failureDetails: 'Технические данные:\nИмяАктивнойФормы: Catalog.Orders.Form', failureStepDescription: 'And I click Create',
        openLogUri: 'command:vscode.open?log', openNestedScenarioUri: 'command:kotTestToolkit.openFailedNestedScenarioFromRun?source' }]);
    assert.match(hover.value, /^\*\*Failed step in scenario "Orders"\*\*/u);
    assert.match(hover.value, /\[Open run log\]\(command:vscode.open\?log\) • \[Open failed nested scenario\]/u);
    assert.deepEqual(Array.from(hover.blocks), ['Element not found', 'Технические данные:\nИмяАктивнойФормы: Catalog.Orders.Form', 'And I click Create']);
    assert.deepEqual(Array.from(hover.isTrusted.enabledCommands), ['vscode.open', 'kotTestToolkit.openRunScenarioLog', 'kotTestToolkit.openFailedNestedScenarioFromRun']);
});

test('unavailable actions are omitted and long diagnostic data is bounded', () => {
    const build = load();
    assert.equal(build([]), undefined);
    const hover = build([{ scenarioName: 'Own', failureDetails: 'x'.repeat(25_000) }]);
    assert.doesNotMatch(hover.value, /command:|\[Open/u);
    assert.match(hover.value, /No failure details available/u);
    assert.equal(hover.blocks[0].length, 20_004);
});
