import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as descriptions from '../src/kotMetadataDescription';
import * as phaseMetadata from '../src/phaseSwitcherMetadata';
import * as parameters from '../src/scenarioParameterUtils';

function harness(native = false) {
    const source = 'ТипФайла: Сценарий\nДанныеСценария:\n    Имя: Sales\n    Код: Sales\n    UID: sales\nТекстСценария: |\n    And I open form named "Sales"\n';
    const nativeMetadata = source.slice(0, source.indexOf('ТекстСценария:'));
    let nativeScript = 'And I open form named "SPPR_SCRIPT_SENTINEL"\n';
    let mutateScript = false;
    const document = { uri: { scheme: 'file', fsPath: native ? '/repo/meta.yaml' : '/repo/scen.yaml', toString: () => native ? 'file:///repo/meta.yaml' : 'file:///repo/scen.yaml' },
        version: 1, getText: () => native ? nativeMetadata : source };
    const patches: Array<{ description: string }> = [];
    const commands: string[] = [];
    const edits: unknown[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    const prompts: string[] = [];
    let mutate = false;
    const host = {
        ProgressLocation: { Notification: 1 },
        WorkspaceEdit: class { replace(...args: unknown[]) { edits.push(args); } },
        window: {
            withProgress: async (_options: unknown, operation: () => Promise<string>) => operation(),
            showInformationMessage: () => undefined,
            showWarningMessage: (message: string) => { warnings.push(message); },
            showErrorMessage: (message: string) => { errors.push(message); }
        },
        workspace: { textDocuments: [document], openTextDocument: async () => document,
            getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
            applyEdit: async () => true },
        commands: { executeCommand: async (command: string) => { commands.push(command); } },
        l10n: { t: (message: string) => message }
    };
    const dependencies: Record<string, unknown> = {
        vscode: host,
        './kotMetadataDescription': descriptions,
        './phaseSwitcherMetadata': phaseMetadata,
        './scenarioParameterUtils': parameters,
        './spprScenarioFiles': { readScenarioSource: async () => nativeMetadata + 'ТекстСценария: |\n    ' + nativeScript },
        './yamlValidator': { isScenarioYamlFile: () => true },
        './projectLibraryIntegration': {
            projectedProjectScenario: () => ({ tabName: 'Shared main group', scenarioDescription: '' }),
            persistProjectMetadata: async (_document: unknown, patch: { description: string }) => { patches.push(patch); return true; }
        },
        './aiClient': {
            getAiConnectionSettings: () => ({ baseUrl: 'http://unused', apiFormat: 'openai', model: 'fake', outputLanguage: 'en' }),
            ensureAiConnectionSettingsComplete: () => undefined,
            buildAiEndpoint: () => 'http://unused',
            requestTextFromAi: async (_endpoint: string, _settings: unknown, _system: string, prompt: string) => {
                prompts.push(prompt);
                if (mutate) { document.version++; mutate = false; }
                if (mutateScript) { nativeScript += 'And concurrent script edit\n'; mutateScript = false; }
                return 'What is checked:\n- The Sales form opens and shows its fields.\nProcess:\n- The user opens the Sales form.\nParameters and branches:\n- No parameters or branches are used.';
            }
        }
    };
    const ts = require('typescript') as typeof import('typescript');
    const module = { exports: {} as any };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'src/scenarioAiDescription.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, require: (name: string) => dependencies[name], console });
    return { document, patches, commands, edits, warnings, errors, prompts, api: module.exports,
        mutateDuringGeneration() { mutate = true; }, mutateScriptDuringGeneration() { mutateScript = true; } };
}

test('AI description stores shared metadata without restoring a KOT YAML block', async () => {
    const h = harness();
    await h.api.handleGenerateScenarioDescriptionWithAi({ document: h.document });
    assert.equal(h.errors.length, 0, JSON.stringify(h.errors));
    assert.equal(h.patches.length, 1);
    assert.ok(h.patches[0].description.length > 0);
    assert.deepEqual(h.edits, []);
    assert.deepEqual(h.commands, ['kotTestToolkit.refreshPhaseSwitcher']);
    assert.ok(h.prompts.some(prompt => prompt.includes('StandaloneMainScenario: yes')));
});

test('AI description refuses a shared metadata write when source changed during generation', async () => {
    const h = harness();
    h.mutateDuringGeneration();
    await h.api.handleGenerateScenarioDescriptionWithAi({ document: h.document });
    assert.deepEqual(h.patches, []);
    assert.deepEqual(h.edits, []);
    assert.equal(h.warnings.length, 1);
});


test('native SPPR AI description analyses its separate script without adding it to metadata', async () => {
    const h = harness(true);
    await h.api.handleGenerateScenarioDescriptionWithAi({ document: h.document });
    assert.deepEqual(h.errors, []);
    assert.equal(h.patches.length, 1);
    assert.ok(h.prompts.some(prompt => prompt.includes('SPPR_SCRIPT_SENTINEL')));
    assert.equal(h.document.getText().includes('ТекстСценария:'), false);
    assert.deepEqual(h.edits, []);
});

test('native SPPR AI description refuses to persist after its script changes during generation', async () => {
    const h = harness(true); h.mutateScriptDuringGeneration();
    await h.api.handleGenerateScenarioDescriptionWithAi({ document: h.document });
    assert.deepEqual(h.patches, []);
    assert.equal(h.warnings.length, 1);
});
