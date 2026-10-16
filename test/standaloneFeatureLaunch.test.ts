import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildStandaloneFeatureLaunchJson, ensureStandaloneFeatureTestClientInfobase, parseStandaloneFeatureLaunchJson, targetStandaloneFeatureLaunchJson } from '../src/standaloneFeatureLaunch';

const profile = { id: 'qa', name: 'QA', buildParameters: [], additionalVanessaParameters: [], globalVanessaVariables: [] };

test('targets exactly one feature after overlays while retaining scenario/tag filters and custom settings', () => {
    const source = { featurepath: '/all', КаталогФич: '/other', FeaturesToRun: ['elsewhere'], scenariofilter: ['Other scenario'], СписокСценариевДляВыполнения: ['Old'], ExceptScenario: 'Old', ignoretags: ['Draft'], СписокТеговОтбор: ['CI'], addtofeaturefilter: true, NameCurrentBuild: 'QA build', RunningScripts: { featurepath: '/nested', scenariofilter: ['other'], Custom: true }, GlobalVars: { featurepath: 'business variable' }, Custom: { scenariofilter: 'business setting' } };
    const result = targetStandaloneFeatureLaunchJson(source, '/repo/tests/order.feature');
    assert.equal(result.featurepath, '/repo/tests/order.feature');
    assert.equal(result.КаталогФич, '/repo/tests/order.feature');
    assert.deepEqual(result.FeaturesToRun, ['/repo/tests/order.feature']);
    assert.deepEqual(result.scenariofilter, ['Other scenario']);
    assert.deepEqual(result.СписокСценариевДляВыполнения, ['Old']);
    assert.equal(result.ExceptScenario, 'Old');
    assert.deepEqual(result.ignoretags, ['Draft']);
    assert.deepEqual(result.СписокТеговОтбор, ['CI']);
    assert.equal(result.addtofeaturefilter, true);
    assert.equal(result.NameCurrentBuild, 'QA build');
    assert.deepEqual(result.RunningScripts, { featurepath: '/repo/tests/order.feature', scenariofilter: ['other'], Custom: true });
    assert.deepEqual(result.GlobalVars, { featurepath: 'business variable' });
    assert.deepEqual(result.Custom, { scenariofilter: 'business setting' });
    assert.equal(source.featurepath, '/all');
});

test('builds launch settings from supported profile fields and resolves paths while excluding SPPR build-only parameters', () => {
    const result = buildStandaloneFeatureLaunchJson({ ...profile, buildParameters: [
        { key: 'LaunchDBFolder', value: 'bases/qa' }, { key: 'VanessaFolder', value: 'tools/vanessa/vanessa-automation.epf' },
        { key: 'Libraries', value: 'libraries|shared/export' }, { key: 'SafeStepsExecution', value: 'True' },
        { key: 'NumberOfAttempts', value: '3' }, { key: 'TestClientPort', value: '1540' }, { key: 'ExtraParams', value: '/Ntester' },
        { key: 'AllurePath', value: 'reports/allure' }, { key: 'AuthCompile', value: 'True' }, { key: 'ModelDBSettings', value: 'secret.yaml' }, { key: 'ScenarioFolder', value: 'all-tests' }
    ] }, { workspaceRootPath: '/repo', featurePath: '/repo/tests/order.feature' });
    assert.equal(result.featurepath, '/repo/tests/order.feature');
    assert.equal(result.instrpath, path.join('/repo', 'tools', 'vanessa'));
    assert.deepEqual(result.librarycatalogs, [path.join('/repo', 'tools', 'vanessa', 'features', 'Libraries'), path.join('/repo', 'libraries'), path.join('/repo', 'shared', 'export')]);
    assert.equal(result.safeexecutionofsteps, true);
    assert.equal(result.numberofattemptstoperformanaction, 3);
    assert.equal(result.allurepath, path.join('/repo', 'reports', 'allure'));
    assert.deepEqual((result.TestClient as { datatestclients: unknown }).datatestclients, [{ Name: 'QA', Synonym: '', ClientType: 'Thin', PathToInfobase: 'File="/repo/bases/qa";', AddItionalParameters: '/Ntester', ComputerName: 'localhost', PortTestClient: 1540 }]);
    assert.equal(result.AuthCompile, undefined);
    assert.equal(result.ModelDBSettings, undefined);
    assert.equal(result.ScenarioFolder, undefined);
    assert.equal(result.createlogs, true);
    assert.equal(result.logtotext, true);
    assert.ok(path.isAbsolute(String(result.logpath)));
    assert.ok(path.isAbsolute(String(result.textlogname)));
});

test('standalone launch uses compiler connection and Vanessa alias precedence rather than row order', () => {
    const result = buildStandaloneFeatureLaunchJson({ ...profile, buildParameters: [
        { key: 'LaunchDBFolder', value: 'ignored-file-base' }, { key: 'TestClientDBPath', value: 'other-file-base' },
        { key: 'InfobasePath', value: 'Srvr="fallback";Ref="QA";' },
        { key: 'Test_Client_DB', value: 'Srvr="preferred";Ref="QA";' },
        { key: 'VanessaDir', value: 'old-dir' }, { key: 'VanessaFolder', value: 'old-folder' },
        { key: 'VanessaPath', value: 'tools/new/vanessa.epf' }
    ] }, { workspaceRootPath: '/repo', featurePath: '/repo/test.feature' });
    assert.equal((result.TestClient as { datatestclients: Array<{ PathToInfobase: string }> }).datatestclients[0].PathToInfobase,
        'Srvr="preferred";Ref="QA";');
    assert.equal(result.instrpath, '/repo/tools/new');
});

test('standalone library arrays use pipe separators, alias precedence and one built-in directory', () => {
    const result = buildStandaloneFeatureLaunchJson({ ...profile, buildParameters: [
        { key: 'VanessaFolder', value: 'tools/vanessa' },
        { key: 'VanessaLibraries', value: 'ignored' },
        { key: 'Libraries', value: 'tools/vanessa/features/Libraries|lib/one|lib/two|./lib/one' }
    ] }, { workspaceRootPath: '/repo', featurePath: '/repo/test.feature' });
    assert.deepEqual(result.librarycatalogs, ['/repo/tools/vanessa/features/Libraries', '/repo/lib/one', '/repo/lib/two']);
});

test('standalone launch preserves Windows connections and supplies Windows built-in libraries once', () => {
    const result = buildStandaloneFeatureLaunchJson({ ...profile, buildParameters: [
        { key: 'LaunchDBFolder', value: 'C:\\Bases\\QA' },
        { key: 'VanessaPath', value: 'C:\\Tools\\Vanessa\\vanessa.epf' },
        { key: 'Libraries', value: 'c:\\tools\\vanessa\\features\\libraries|C:\\Shared\\Steps' },
        { key: 'ExtraParams', value: ' /N"Synthetic" /P"token\\literal" ' }
    ] }, { workspaceRootPath: '/repo', featurePath: '/repo/test.feature' });
    assert.equal(result.instrpath, 'C:\\Tools\\Vanessa');
    assert.deepEqual(result.librarycatalogs, ['C:\\Tools\\Vanessa\\features\\Libraries', 'C:\\Shared\\Steps']);
    const client = (result.TestClient as { datatestclients: Array<{ PathToInfobase: string; AddItionalParameters: string }> }).datatestclients[0];
    assert.equal(client.PathToInfobase, 'File="C:\\Bases\\QA";');
    assert.equal(client.AddItionalParameters, ' /N"Synthetic" /P"token\\literal" ');
});

test('blank preferred aliases suppress fallback Vanessa directories and libraries', () => {
    const result = buildStandaloneFeatureLaunchJson({ ...profile, buildParameters: [
        { key: 'VanessaFolder', value: 'ignored-vanessa' }, { key: 'VanessaPath', value: '' },
        { key: 'VanessaLibraries', value: 'ignored-library' }, { key: 'Libraries', value: '' }
    ] }, { workspaceRootPath: '/repo', featurePath: '/repo/test.feature' });
    assert.equal(result.instrpath, undefined);
    assert.deepEqual(result.librarycatalogs, []);
});

test('standalone folder aliases retain supported workspace placeholders and quoted path syntax', () => {
    const result = buildStandaloneFeatureLaunchJson({ ...profile, buildParameters: [
        { key: 'TestClientDBPath', value: 'ignored' },
        { key: 'LaunchDBFolder', value: '"${workspaceFolder}/bases/QA"' }
    ] }, { workspaceRootPath: '/repo', featurePath: '/repo/test.feature' });
    assert.equal((result.TestClient as { datatestclients: Array<{ PathToInfobase: string }> }).datatestclients[0].PathToInfobase,
        'File="/repo/bases/QA";');
});

test('merges profile additional settings and globals using aliases/override rules and preserves authored custom settings', () => {
    const baseJson = { БезопасноеВыполнениеШагов: false, Custom: { mode: 'keep' }, GlobalVars: { Existing: 'keep' } };
    const result = buildStandaloneFeatureLaunchJson({ ...profile, buildParameters: [{ key: 'SafeStepsExecution', value: 'True' }], additionalVanessaParameters: [
        { key: 'safeexecutionofsteps', value: 'false', overrideExisting: false }, { key: 'Custom.New', value: '42', overrideExisting: true }, { key: 'featurepath', value: '/all', overrideExisting: true }
    ], globalVanessaVariables: [{ key: 'Existing', value: 'replace', overrideExisting: false }, { key: 'Enabled', value: 'true', overrideExisting: true }] }, { featurePath: '/repo/test.feature', workspaceRootPath: '/repo', baseJson });
    assert.equal(result.БезопасноеВыполнениеШагов, true);
    assert.deepEqual(result.Custom, { mode: 'keep', New: 42 });
    assert.deepEqual(result.GlobalVars, { Existing: 'keep', Enabled: true });
    assert.equal(result.featurepath, '/repo/test.feature');
    assert.equal(baseJson.БезопасноеВыполнениеШагов, false);
});

test('retains server connections and rejects malformed known fields instead of emitting invalid Vanessa values', () => {
    const result = buildStandaloneFeatureLaunchJson({ ...profile, buildParameters: [{ key: 'TestClientDBPath', value: 'Srvr="server";Ref="QA";' }] }, { featurePath: '/repo/test.feature', workspaceRootPath: '/repo' });
    assert.match(JSON.stringify(result), /Srvr=/u);
    assert.throws(() => buildStandaloneFeatureLaunchJson({ ...profile, buildParameters: [{ key: 'NumberOfAttempts', value: 'NaN' }] }, { featurePath: '/repo/test.feature', workspaceRootPath: '/repo' }), /NumberOfAttempts/u);
    assert.throws(() => buildStandaloneFeatureLaunchJson({ ...profile, buildParameters: [{ key: 'SafeStepsExecution', value: 'maybe' }] }, { featurePath: '/repo/test.feature', workspaceRootPath: '/repo' }), /SafeStepsExecution/u);
    assert.throws(() => targetStandaloneFeatureLaunchJson({}, ''), /feature/iu);
});

test('reads BOM-authored JSON and rejects non-object launch settings', () => {
    assert.deepEqual(parseStandaloneFeatureLaunchJson('\uFEFF{"Custom":true}'), { Custom: true });
    assert.throws(() => parseStandaloneFeatureLaunchJson('[]'), /object/iu);
});

test('updates existing aliased client settings while retaining custom authentication and additional clients', () => {
    const result = buildStandaloneFeatureLaunchJson({ ...profile, buildParameters: [{ key: 'LaunchDBFolder', value: 'bases/new' }, { key: 'SafeStepsExecution', value: 'True' }] }, {
        featurePath: '/repo/test.feature', workspaceRootPath: '/repo', baseJson: {
            ДанныеКлиентовТестирования: [{ Имя: 'Authored', ПутьКИнфобазе: 'File="/old";', ДопПараметры: '/Nuser /Psecret', Custom: true }, { Имя: 'Second', ПутьКИнфобазе: 'File="/second";' }],
            ВыполнениеСценариев: { БезопасноеВыполнениеШагов: false, CustomMode: 'keep' }
        }
    });
    const clients = result.ДанныеКлиентовТестирования as Array<Record<string, unknown>>;
    assert.equal(clients[0].ПутьКИнфобазе, 'File="/repo/bases/new";');
    assert.equal(clients[0].ДопПараметры, '/Nuser /Psecret');
    assert.equal(clients[0].Имя, 'Authored');
    assert.equal(clients[0].Custom, true);
    assert.equal(clients[1].ПутьКИнфобазе, 'File="/second";');
    assert.equal(result.TestClient, undefined);
    assert.deepEqual(result.ВыполнениеСценариев, { БезопасноеВыполнениеШагов: true, CustomMode: 'keep' });
    assert.equal(result.safeexecutionofsteps, undefined);
});

test('fills a missing TestClient connection in a cloned JSON with standard client defaults', () => {
    const source = { Custom: { Enabled: true } };
    const result = ensureStandaloneFeatureTestClientInfobase(source, '/repo/bases/QA');
    assert.deepEqual(result, { Custom: { Enabled: true }, TestClient: { datatestclients: [{ Name: 'TestClient', Synonym: '', ClientType: 'Thin', PathToInfobase: 'File="/repo/bases/QA";', AddItionalParameters: '', ComputerName: 'localhost', PortTestClient: 1538 }] } });
    assert.deepEqual(source, { Custom: { Enabled: true } });
});

test('fills an aliased client connection while retaining its credentials, custom settings and additional clients', () => {
    const source = { ДанныеКлиентовТестирования: [{ Имя: 'Authored', ПутьКИнфобазе: '', ДопПараметры: '/Nuser /Psecret', ТипКлиента: 'Thick', ПортЗапускаТестКлиента: 1540, Custom: true }, { Имя: 'Second', Custom: true }], Custom: { mode: 'keep' } };
    const result = ensureStandaloneFeatureTestClientInfobase(source, '/repo/bases/QA');
    const clients = result.ДанныеКлиентовТестирования as Array<Record<string, unknown>>;
    assert.equal(clients[0].ПутьКИнфобазе, 'File="/repo/bases/QA";');
    assert.equal(clients[0].ДопПараметры, '/Nuser /Psecret');
    assert.equal(clients[0].Имя, 'Authored');
    assert.equal(clients[0].ТипКлиента, 'Thick');
    assert.equal(clients[0].ПортЗапускаТестКлиента, 1540);
    assert.equal(clients[0].Custom, true);
    assert.deepEqual(clients[1], { Имя: 'Second', Custom: true });
    assert.deepEqual(result.Custom, { mode: 'keep' });
    assert.equal(result.TestClient, undefined);
    assert.equal(source.ДанныеКлиентовТестирования[0].ПутьКИнфобазе, '');
});

test('retains an existing connection and supports selected server connections without wrapping them as file paths', () => {
    const existing = { TestClient: { datatestclients: [{ Name: 'Authored', PathToInfobase: 'File="/existing";' }] } };
    const retained = ensureStandaloneFeatureTestClientInfobase(existing, '/new');
    assert.equal(((retained.TestClient as { datatestclients: Array<{ PathToInfobase: string }> }).datatestclients[0]).PathToInfobase, 'File="/existing";');
    const server = ensureStandaloneFeatureTestClientInfobase({}, 'Srvr="server";Ref="QA";');
    assert.equal(((server.TestClient as { datatestclients: Array<{ PathToInfobase: string }> }).datatestclients[0]).PathToInfobase, 'Srvr="server";Ref="QA";');
    assert.throws(() => ensureStandaloneFeatureTestClientInfobase({}, ''), /infobase/iu);
});
