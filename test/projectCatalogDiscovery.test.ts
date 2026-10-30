import { v3Fixture } from './helpers/projectFormat';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverProjectCatalogs } from '../src/projectCatalogDiscovery';
import { parseTestInfoFromScenarioSource } from '../src/scenarioDescriptor';
import { ProjectPropertyCatalogStore } from '../src/projectPropertyCatalogStore';
import { TestNumberingStore } from '../src/testNumberingStore';
import type { TestInfo } from '../src/types';

test('saved headers populate shared catalogs without treating the current responsible as the code-series author', async t => {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-discovery-')));
    t.after(() => fs.rm(root, { force: true, recursive: true }));
    const info = (code: string, responsible: string, file = path.join(root, code, 'scen.yaml')) => parseTestInfoFromScenarioSource(
        `ТипФайла: Сценарий\nДанныеСценария:\n  Имя: Test ${code}\n  Код: '${code}'\n  Проект: Drive\n  Ответственный: ${responsible}\n  УровеньОтчета1: Sales\n  УровеньОтчета2: Orders\n  ФункцияСистемы: Sales\n  UIDФункцияСистемы: 98999f57-13dc-11e8-aed1-005056a5c4e8\nТекстСценария: |\n  И готово\n`,
        { scheme: 'file', fsPath: file } as TestInfo['yamlFileUri'], code)!;
    const all = [info('000012003', 'Alex'), info('000012009', 'Alex'), info('000013001', 'One'), info('000013002', 'Two'),
        info('000014001', 'Outside', path.join(root, '..', 'other', 'scen.yaml'))];
    all[0].scenarioCategory = 'Smoke';
    await discoverProjectCatalogs(root, all, () => undefined);
    assert.deepEqual(await new ProjectPropertyCatalogStore(root).read(), {
        projects: ['Drive'], reportLevel1: ['Sales'], reportLevel2: ['Orders'], responsibles: ['Alex', 'One', 'Two'], categories: ['Smoke'],
        systemFunctions: [{ name: 'Sales', uid: '98999f57-13dc-11e8-aed1-005056a5c4e8' }]
    });
    const numbering = new TestNumberingStore(root);
    assert.deepEqual((await numbering.read()).series, []);
    await numbering.addSeries('000012', 'Original author', ['000012003', '000012009']);
    assert.equal(await numbering.suggest('000012', []), '000012010');
    await discoverProjectCatalogs(root, [info('000012010', 'New author')], () => undefined);
    assert.equal((await numbering.read()).series[0].author, 'Original author');
});

test('dirty catalog blocks discovery before writing shared values', async t => {
    const root = await v3Fixture(fs.mkdtemp(path.join(os.tmpdir(), 'kot-discovery-dirty-')));
    t.after(() => fs.rm(root, { force: true, recursive: true }));
    await assert.rejects(discoverProjectCatalogs(root, [], () => { throw new Error('Save catalog'); }), /Save catalog/);
    assert.deepEqual(await fs.readdir(path.join(root,'.kot')),['project.yml']);
});
