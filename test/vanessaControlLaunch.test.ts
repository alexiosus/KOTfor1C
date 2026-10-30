import assert from 'node:assert/strict';
import test from 'node:test';
import { managedVanessaCommandParts } from '../src/vanessaControlLaunch';
import * as launch from '../src/vanessaControlLaunch';
test('managed launch enables MCP/editor with an explicit loopback port and never starts the feature player', () => {
    assert.deepEqual(managedVanessaCommandParts(['ShowMainForm', 'UseEditor', 'VAParams=C:\\debug.json'], 9876),
        ['ShowMainForm', 'UseEditor', 'VAParams=C:\\debug.json', 'runMcp', 'mcpPort=9876']);
    for (const port of [0, -1, 65536, 1.5]) { assert.throws(() => managedVanessaCommandParts([], port)); }
    assert.throws(() => managedVanessaCommandParts(['StartFeaturePlayer'], 9876));
});
test('managed authoring defaults to the configured language while retaining the explicit additional parameter alias', () => {
    const configure = (launch as any).withVanessaAuthoringLanguageDefault;
    assert.equal(typeof configure, 'function');
    assert.equal(configure({}, 'en').ЯзыкГенератораGherkin, 'en');
    assert.deepEqual(configure({ gherkinlanguage: 'ru' }, 'en'), { gherkinlanguage: 'ru', Lang: 'ru' });
    assert.deepEqual(configure({ ЯзыкГенератораGherkin: 'en', Own: true }, 'ru'), { ЯзыкГенератораGherkin: 'en', Own: true, Lang: 'en' });
});

test('managed launch prevents a conflicting Lang field from overriding the explicit generator language', () => {
    const value = launch.withVanessaAuthoringLanguageDefault({ gherkinlanguage: 'en', Lang: 'ru' }, 'ru') as any;
    assert.equal(value.Lang, 'en'); assert.equal(value.gherkinlanguage, 'en');
    assert.equal((launch.withVanessaAuthoringLanguageDefault({ Lang: 'ru' }, 'en') as any).ЯзыкГенератораGherkin, 'ru');
});
