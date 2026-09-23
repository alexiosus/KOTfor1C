import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createActiveYamlParametersProfileSnapshot,
    getActiveYamlParametersProfileChange,
    type YamlParametersStateLike
} from '../src/activeYamlParametersProfile';

function createState(activeProfileId = 'default'): YamlParametersStateLike {
    return {
        activeProfileId,
        profiles: [
            {
                id: 'default',
                name: 'Default',
                buildParameters: [{ key: 'Libraries', value: 'libraries' }],
                additionalVanessaParameters: [{ key: 'stoponerror', value: 'true', overrideExisting: false }],
                globalVanessaVariables: [{ key: 'Mode', value: 'safe', overrideExisting: true }]
            },
            {
                id: 'second',
                name: 'Second',
                buildParameters: [{ key: 'Libraries', value: 'other' }],
                additionalVanessaParameters: [],
                globalVanessaVariables: []
            }
        ]
    };
}

test('active profile snapshot is a frozen defensive copy', () => {
    const state = createState();
    const snapshot = createActiveYamlParametersProfileSnapshot(state);

    state.profiles[0].buildParameters[0].value = 'changed';
    state.profiles[0].additionalVanessaParameters[0].value = 'false';

    assert.equal(snapshot.buildParameters[0].value, 'libraries');
    assert.equal(snapshot.additionalVanessaParameters[0].value, 'true');
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.buildParameters), true);
    assert.equal(Object.isFrozen(snapshot.buildParameters[0]), true);
});

test('profile change detection distinguishes selection, content, and no change', () => {
    const previous = createState();
    const selected = createState('second');
    const edited = createState();
    edited.profiles[0].buildParameters[0].value = 'new-libraries';

    assert.deepEqual(getActiveYamlParametersProfileChange(previous, selected), {
        oldProfileId: 'default',
        newProfileId: 'second',
        reason: 'selection'
    });
    assert.deepEqual(getActiveYamlParametersProfileChange(previous, edited), {
        oldProfileId: 'default',
        newProfileId: 'default',
        reason: 'content'
    });
    assert.equal(getActiveYamlParametersProfileChange(previous, createState()), null);
});

test('active profile helpers reject a state without profiles', () => {
    assert.throws(
        () => createActiveYamlParametersProfileSnapshot({ activeProfileId: 'missing', profiles: [] }),
        /at least one profile/i
    );
});
