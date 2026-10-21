import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import * as panels from '../src/vanessaControlVariablesPanel';
import * as variables from '../src/vanessaControlVariables';

test('an already visible variables view loads when attach becomes ready and has no permanent runtime disclaimer', async () => {
    const listeners: Array<() => void> = []; let provider: any; let reads = 0;
    let snapshot = { generation: 1, status: 'detached', capabilities: { variablesRead: { supported: true }, variablesWrite: { supported: true } } };
    const view: any = { visible: true, dispose() {}, onDidChangeVisibility: () => ({ dispose() {} }) };
    class Emitter { listeners = new Set<() => void>(); event = (listener: () => void) => { this.listeners.add(listener); return { dispose() {} }; }; fire() { for (const listener of this.listeners) { listener(); } } dispose() {} }
    const vscode = { EventEmitter: Emitter, l10n: { t: (value: string) => value }, window: { createTreeView: (_id: string, options: any) => { provider = options.treeDataProvider; return view; } },
        commands: { registerCommand: () => ({ dispose() {} }) } };
    const module = { exports: {} as any }; const ts = require('typescript') as typeof import('typescript');
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/vanessaControlVariableCommands.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: (name: string) => name === 'vscode' ? vscode : name.endsWith('VariablesPanel') ? panels : variables });
    module.exports.registerVanessaVariableCommands({ subscriptions: [] }, { get snapshot() { return snapshot; }, busy: false,
        onDidChange: (callback: () => void) => { listeners.push(callback); return { dispose() {} }; },
        withVariableControl: async (work: (runtime: variables.VanessaRuntimeVariables) => Promise<unknown>) => { reads++; return work(new variables.VanessaRuntimeVariables({ request: async () => ({ content: [{ type: 'text', text: '# Переменные контекста\n\n## Контекст ($var$)\n- `Own` = Value\n\n## Сохраняемый контекст ($$var$$)' }] }) })); } });
    assert.equal(reads, 0); snapshot = { ...snapshot, status: 'ready' }; for (const listener of listeners) { listener(); }
    const deadline = Date.now() + 1000;
    while (!provider.getChildren({ scope: 'local' }).length && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(reads, 1); assert.equal(provider.getChildren({ scope: 'local' }).length, 1); assert.equal(view.message, undefined);
    const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    assert.equal(manifest.contributes.commands.find((command: any) => command.command === 'kotTestToolkit.vanessaControl.variables.set').icon, '$(edit)');
});
