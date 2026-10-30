import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectDisabledProcessSettingsFiles, adaptNestedProcessFilters } from '../src/compilerProcessSelection';
import type { TestInfo } from '../src/types';

test('disabled process isolation finds UID-linked settings, leaving descriptors and enabled dependencies intact', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-process-selection-'));
    try {
        await fs.mkdir(path.join(root, 'unusual', 'settings'), { recursive: true });
        const disabled = path.join(root, 'unusual', 'settings', 'alternative.yaml');
        await fs.writeFile(disabled, 'ТипФайла: "НастройкаПроцесса"\nДанныеТеста:\n  UIDПроцесса: "UID-P"\n');
        const descriptor = path.join(root, 'process.yaml');
        await fs.writeFile(descriptor, 'ТипФайла: "Процесс"\nДанныеПроцесса:\n  UID: "UID-P"\n');
        await fs.writeFile(path.join(root, 'enabled.yaml'), 'ТипФайла: "НастройкаПроцесса"\nДанныеТеста:\n  UIDПроцесса: "enabled"\n');
        await fs.writeFile(path.join(root, 'scenario.yaml'), 'ТипФайла: "НастройкаТеста"\nДанныеТеста:\n  UIDСценария: "UID-P"\n');
        assert.deepEqual(await collectDisabledProcessSettingsFiles(root, [{ uid: 'uid-p', name: 'Disabled process' }]), [{ filePath: disabled, processName: 'Disabled process' }]);
        assert.equal((await fs.readFile(descriptor, 'utf8')).includes('UID-P'), true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('nested process code filters expand to ancestor settings and retain the existing settings union', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-nested-filter-'));
    try {
        for (const [uid, code] of [['parent', 'parent-setting'], ['child', 'child-setting'], ['other', 'other-setting']]) {
            await fs.writeFile(path.join(root, `${uid}.yaml`), `ТипФайла: "НастройкаПроцесса"\nДанныеТеста:\n  UIDПроцесса: "${uid}"\n  Код: "${code}"\n`);
        }
        const processes = [
            { kind: 'process', name: 'Parent', uid: 'parent', processCode: 'Sales', processSteps: [{ type: 'process', processUid: 'child' }] },
            { kind: 'process', name: 'Child', uid: 'child', processCode: 'Sales.Payment', processSteps: [] },
            { kind: 'process', name: 'Other', uid: 'other', processCode: 'Other', processSteps: [] }
        ] as TestInfo[];
        const adapted = await adaptNestedProcessFilters([
            { key: 'Process_Filter', value: 'Sales.Payment' }, { key: 'ProcessSettingsFilter', value: 'explicit-other' }, { key: 'Custom', value: 'keep' }
        ], processes, root);
        assert.equal(adapted.some(row => row.key === 'Process_Filter'), false);
        assert.deepEqual(adapted.find(row => row.key === 'ProcessSettingsFilter')?.value.split(';').sort(), ['child-setting', 'explicit-other', 'parent-setting']);
        assert.equal(adapted.find(row => row.key === 'Custom')?.value, 'keep');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('nested process filter conversion rejects settings-code collisions, including UIDs outside the catalog', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-nested-filter-collision-'));
    try {
        await fs.writeFile(path.join(root, 'selected.yaml'), 'ТипФайла: "НастройкаПроцесса"\nДанныеТеста:\n  UIDПроцесса: "parent"\n  Код: "shared"\n');
        const unrelated = path.join(root, 'unrelated.yaml');
        await fs.writeFile(unrelated, 'ТипФайла: "НастройкаПроцесса"\nДанныеТеста:\n  UIDПроцесса: "other"\n  Код: "SHARED"\n');
        const processes = [
            { kind: 'process', name: 'Parent', uid: 'parent', processCode: 'Sales', processSteps: [{ type: 'process', processUid: 'child' }] },
            { kind: 'process', name: 'Child', uid: 'child', processCode: 'Sales.Payment', processSteps: [] }
        ] as TestInfo[];
        for (const catalog of [processes, [...processes, { kind: 'process', name: 'Other', uid: 'other', processCode: 'Other' } as TestInfo]]) {
            await assert.rejects(adaptNestedProcessFilters([{ key: 'ProcessFilter', value: 'Sales' }], catalog, root), error => {
                assert.match(String(error), /shared/iu);
                assert.ok(String(error).includes(unrelated));
                return true;
            });
        }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an explicit process settings filter retains its intentional union when settings codes collide', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-nested-filter-explicit-'));
    try {
        for (const uid of ['parent', 'other']) {
            await fs.writeFile(path.join(root, `${uid}.yaml`), `ТипФайла: "НастройкаПроцесса"\nДанныеТеста:\n  UIDПроцесса: "${uid}"\n  Код: "shared"\n`);
        }
        const processes = [
            { kind: 'process', name: 'Parent', uid: 'parent', processCode: 'Sales', processSteps: [{ type: 'process', processUid: 'child' }] },
            { kind: 'process', name: 'Child', uid: 'child', processCode: 'Sales.Payment', processSteps: [] }
        ] as TestInfo[];
        const adapted = await adaptNestedProcessFilters([
            { key: 'ProcessFilter', value: 'Sales' }, { key: 'ProcessSettings_Filter', value: 'SHARED' }
        ], processes, root);
        assert.equal(adapted.some(row => row.key === 'ProcessFilter'), false);
        assert.ok(adapted.find(row => row.key === 'ProcessSettingsFilter')?.value.split(';').some(code => code.toLowerCase() === 'shared'));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
