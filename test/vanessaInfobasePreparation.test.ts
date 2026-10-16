import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import vm from 'node:vm';
import * as infobaseConnection from '../src/oneCInfobaseConnection';
import * as vanessaVersion from '../src/vanessaVersion';

function preparationFixture(t: TestContext, selections: string[]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-vanessa-preparation-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const targetPath = path.join(directory, 'infobase');
    const newTargetPath = path.join(directory, 'new-infobase');
    fs.mkdirSync(targetPath);
    const dataFile = path.join(targetPath, '1Cv8.1CD');
    fs.writeFileSync(dataFile, 'existing data');
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const module = { exports: {} as any };
    const source = fs.readFileSync(path.join(process.cwd(), 'src/phaseSwitcher.ts'), 'utf8');
    const remainingSelections = [...selections];
    const vscode = {
        EventEmitter: class {},
        workspace: { getConfiguration: () => ({ get: () => directory }) },
        window: {
            showQuickPick: async (items: Array<{ source?: string; actionKey?: string }>) => {
                const expected = remainingSelections.shift();
                const selected = items.find(item => (item.source ?? item.actionKey) === expected);
                assert.ok(selected, `Unexpected preparation prompt while selecting ${expected}`);
                return selected;
            },
            showErrorMessage: (message: string) => assert.fail(message)
        }
    };
    vm.runInNewContext(ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, {
        module, exports: module.exports, Buffer, console, process, setTimeout, clearTimeout, setInterval, clearInterval,
        require: (name: string) => {
            if (name === 'vscode') { return vscode; }
            if (['fs', 'path', 'os'].includes(name)) { return require(name); }
            if (name === './oneCInfobaseConnection') { return infobaseConnection; }
            if (name === './vanessaVersion') { return vanessaVersion; }
            if (name === './deferredLoader') { return { createDeferredLoader: (factory: unknown) => factory }; }
            if (name === './infobasePicker.js') { return { resolveLauncherInfobaseNameByPath: async () => 'Fixture' }; }
            return {};
        }
    });
    const provider = Object.create(module.exports.PhaseSwitcherProvider.prototype) as any;
    provider.t = (message: string) => message;
    provider.getScenarioCustomInfobasePath = async () => undefined;
    provider.resolvePreferredRestoreDtPathForScenario = async () => path.join(directory, 'etalon.dt');
    provider.promptNewVanessaInfobasePath = async () => ({ targetInfobasePath: newTargetPath, launcherRegistrationName: 'Fixture' });
    return { provider, directory, targetPath, newTargetPath, dataFile, remainingSelections };
}

test('keeping the selected infobase offers configuration update without a DT restore or recreation', async t => {
    const f = preparationFixture(t, ['json', 'keep', 'sourceDirectory']);
    const plan = await f.provider.promptVanessaInfobasePreparationPlan('scenario', 'Scenario', f.directory, f.targetPath);
    assert.equal(plan.targetInfobasePath, f.targetPath);
    assert.equal(plan.createNewInfobase, false);
    assert.equal(plan.recreateExistingInfobase, undefined);
    assert.equal(plan.restoreDtPath, undefined);
    assert.equal(plan.updateConfiguration.kind, 'sourceDirectory');
    assert.equal(plan.updateConfiguration.sourcePath, f.directory);
    assert.equal(f.remainingSelections.length, 0);
    assert.equal(fs.readFileSync(f.dataFile, 'utf8'), 'existing data');
});

test('recreating the selected infobase still offers the etalon DT restore', async t => {
    const f = preparationFixture(t, ['json', 'reset', 'restoreEtalon', 'skip']);
    const plan = await f.provider.promptVanessaInfobasePreparationPlan('scenario', 'Scenario', f.directory, f.targetPath);
    assert.equal(plan.createNewInfobase, false);
    assert.equal(plan.recreateExistingInfobase, true);
    assert.equal(plan.restoreDtPath, path.join(f.directory, 'etalon.dt'));
    assert.equal(plan.updateConfiguration, undefined);
    assert.equal(f.remainingSelections.length, 0);
    assert.equal(fs.readFileSync(f.dataFile, 'utf8'), 'existing data');
});

test('creating a new infobase still offers the etalon DT restore', async t => {
    const f = preparationFixture(t, ['create', 'restoreEtalon', 'skip']);
    const plan = await f.provider.promptVanessaInfobasePreparationPlan('scenario', 'Scenario', f.directory, '');
    assert.equal(plan.targetInfobasePath, f.newTargetPath);
    assert.equal(plan.createNewInfobase, true);
    assert.equal(plan.recreateExistingInfobase, undefined);
    assert.equal(plan.restoreDtPath, path.join(f.directory, 'etalon.dt'));
    assert.equal(plan.updateConfiguration, undefined);
    assert.equal(f.remainingSelections.length, 0);
    assert.equal(fs.existsSync(f.newTargetPath), false);
});
