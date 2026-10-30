import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
    buildDestructiveInfobaseImportConfirmation,
    type DestructiveInfobaseImportKind
} from '../src/infobaseDestructiveConfirmation';
import type { Translator } from '../src/localization';

const translate: Translator = (message, ...args) => message.replace(/\{(\d+)\}/gu, (placeholder, index) => {
    const argument = args[Number(index)];
    return argument === undefined ? placeholder : argument;
});

const target = {
    displayName: 'Sales QA',
    infobasePath: 'Srvr="qa-server";Ref="sales";'
};

const cases: ReadonlyArray<{
    kind: DestructiveInfobaseImportKind;
    sourcePath: string;
    confirmLabel: string;
    consequence: RegExp;
}> = [
    {
        kind: 'dt',
        sourcePath: './fixtures/backups/sales.dt',
        confirmLabel: 'Restore DT',
        consequence: /data and configuration will be replaced/iu
    },
    {
        kind: 'cf',
        sourcePath: './fixtures/configuration/sales.cf',
        confirmLabel: 'Load CF',
        consequence: /configuration will be replaced.*database configuration will be updated/iu
    },
    {
        kind: 'sourceDirectory',
        sourcePath: './fixtures/configuration/src',
        confirmLabel: 'Load source directory',
        consequence: /configuration will be replaced.*database configuration will be updated/iu
    }
];

for (const testCase of cases) {
    test(`builds a complete ${testCase.kind} destructive-import confirmation`, () => {
        const confirmation = buildDestructiveInfobaseImportConfirmation(
            testCase.kind,
            testCase.sourcePath,
            target,
            translate
        );

        assert.equal(confirmation.confirmLabel, testCase.confirmLabel);
        assert.match(confirmation.title, /Sales QA/u);
        assert.ok(confirmation.detail.includes(path.resolve(testCase.sourcePath)));
        assert.ok(confirmation.detail.includes(target.displayName));
        assert.ok(confirmation.detail.includes(target.infobasePath));
        assert.match(confirmation.detail, testCase.consequence);
    });
}

test('destructive imports confirm after source selection and before any busy check or Designer run', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'infobaseManager.ts'), 'utf8');
    const restoreStart = source.indexOf('export async function restoreInfobaseFromDtInteractive');
    const updateStart = source.indexOf('export async function updateInfobaseConfigurationInteractive');
    const renameStart = source.indexOf('export async function renameInfobaseInteractive');
    const restoreBody = source.slice(restoreStart, updateStart);
    const updateBody = source.slice(updateStart, renameStart);

    const restorePicker = restoreBody.indexOf('showOpenDialog');
    const restoreConfirmation = restoreBody.indexOf("buildDestructiveInfobaseImportConfirmation(\n        'dt'");
    const restoreBusyCheck = restoreBody.indexOf('assertInfobaseNotBusy');
    const restoreRun = restoreBody.indexOf('runInfobaseDesignerCommandWithAuthRetry');
    assert.ok(restorePicker >= 0 && restorePicker < restoreConfirmation);
    assert.ok(restoreConfirmation < restoreBusyCheck);
    assert.ok(restoreConfirmation < restoreRun);

    const sourceDirectoryValidation = updateBody.indexOf('directoryExists(configuredSourceDirectory)');
    const cfPicker = updateBody.indexOf('showOpenDialog');
    const updateConfirmation = updateBody.indexOf('buildDestructiveInfobaseImportConfirmation(');
    const updateBusyCheck = updateBody.indexOf('assertInfobaseNotBusy');
    const updateRun = updateBody.indexOf('runInfobaseDesignerCommandWithAuthRetry');
    assert.ok(sourceDirectoryValidation >= 0 && sourceDirectoryValidation < updateConfirmation);
    assert.ok(cfPicker >= 0 && cfPicker < updateConfirmation);
    assert.ok(updateConfirmation < updateBusyCheck);
    assert.ok(updateConfirmation < updateRun);
    assert.match(updateBody, /selection\.modeKey === 'sourceDirectory'\s*\? 'sourceDirectory'\s*:\s*'cf'/u);
});
