import assert from 'node:assert/strict';
import test from 'node:test';
const ui = require('../media/userStepLibraries.js');

test('library UI offers source operations while withholding copy/insert for unavailable steps', () => {
    for (const status of ['sourceOnly', 'uncompiled', 'stale']) {
        const item = { kind: 'userStep', insertable: false, navigable: true,
            userStepLibrary: { status, sourceDirectory: '/src', ...(status !== 'sourceOnly' ? { rootXmlPath: '/src/Обработка.xml', targetEpfPath: '/Steps.epf' } : {}) } };
        assert.equal(ui.canCopy(item), false);
        const actions = ui.actions(item, {});
        assert.ok(actions.some((action: any) => action.id === 'buildUserStepLibrary'));
        assert.equal(actions.some((action: any) => action.id === 'dumpUserStepLibrary'), status === 'stale');
    }
    assert.equal(ui.canCopy({ kind: 'builtInStep', insertable: false }), true);
    assert.equal(ui.canCopy({ definitionType: 'userStep', insertable: false }), false);
    assert.equal(ui.canCopy({ kind: 'userStep', insertable: true }), true);
});
