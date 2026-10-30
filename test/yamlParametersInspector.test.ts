import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function harness() {
    const script = fs.readFileSync(path.join(process.cwd(), 'media/yamlParameters.js'), 'utf8');
    const start = script.indexOf('    function inspectParameter(');
    const end = script.indexOf('\n    document.addEventListener', start);
    const title = { textContent: '' }; const description = { textContent: '' };
    const previous = { classList: { remove: (_name: string) => { removed = true; } } };
    let removed = false; let inspected = false;
    const row = { querySelector: () => ({ value: 'CreateJson' }), closest: (selector: string) => selector === '#buildParametersTable',
        classList: { add: (_name: string) => { inspected = true; } } };
    class Element { closest() { return row; } }
    const document = { getElementById: (id: string) => id.endsWith('Title') ? title : id.endsWith('Description') ? description : undefined,
        querySelectorAll: () => [previous], querySelector: () => ({ textContent: 'Other parameters' }) };
    const inspect = vm.runInNewContext(`${script.slice(start, end)}\ninspectParameter`, {
        HTMLElement: Element, document, uiLoc: { paramNamePlaceholder: 'Parameter', customBuildParameterDescription: 'Custom parameter' },
        getBuildParameterDefinition: () => ({ description: 'Generate a Vanessa launch JSON for each compiled test.' })
    }) as (event: { target: unknown }) => void;
    return { inspect, target: new Element(), title, description, removed: () => removed, inspected: () => inspected };
}

test('the parameter inspector follows the selected row and shows its compiler description', () => {
    const h = harness(); h.inspect({ target: h.target });
    assert.equal(h.title.textContent, 'CreateJson');
    assert.match(h.description.textContent, /Vanessa launch JSON/u);
    assert.equal(h.removed(), true); assert.equal(h.inspected(), true);
});

test('unrelated clicks leave parameter details untouched', () => {
    const h = harness(); h.inspect({ target: {} });
    assert.equal(h.title.textContent, ''); assert.equal(h.inspected(), false);
});

test('the inspector is shared by SPPR and Vanessa tabs and hidden for global variables', () => {
    const script = fs.readFileSync(path.join(process.cwd(), 'media/yamlParameters.js'), 'utf8');
    const start = script.indexOf('    function setActiveTab(');
    const end = script.indexOf('    function manageProfiles(', start);
    const elements = new Map<string, { hidden: boolean; classList: { toggle(name: string, value: boolean): void }; setAttribute(): void }>();
    const classes = new Map<string, boolean>();
    for (const id of ['buildTabBtn', 'additionalTabBtn', 'globalVarsTabBtn', 'buildTabPanel', 'additionalTabPanel', 'globalVarsTabPanel', 'parameterInspector']) {
        elements.set(id, { hidden: false, classList: { toggle: (name, value) => { classes.set(`${id}:${name}`, value); } }, setAttribute() {} });
    }
    const workspace = { classList: { toggle: (name: string, value: boolean) => { classes.set(name, value); } } };
    let splitterUpdates = 0;
    const setTab = vm.runInNewContext(`let activeTab; ${script.slice(start, end)}\nsetActiveTab`, {
        document: { getElementById: (id: string) => elements.get(id), querySelector: () => workspace },
        paneSplitter: { update: () => { splitterUpdates++; } }, resetParameterInspector() {}
    });
    setTab('additional'); assert.equal(elements.get('parameterInspector')?.hidden, false);
    assert.equal(classes.get('has-build-inspector'), true);
    setTab('globalVars'); assert.equal(elements.get('parameterInspector')?.hidden, true);
    setTab('build'); assert.equal(elements.get('parameterInspector')?.hidden, false);
    assert.equal(classes.get('has-build-inspector'), true);
    assert.equal(splitterUpdates, 3);
});

test('Vanessa parameter rows never replace SPPR descriptions', () => {
    const script = fs.readFileSync(path.join(process.cwd(), 'media/yamlParameters.js'), 'utf8');
    const start = script.indexOf('    function inspectParameter('); const end = script.indexOf('\n    document.addEventListener', start);
    const title = { textContent: 'CreateJson' }; const description = { textContent: 'SPPR description' };
    const row = { closest: () => null, querySelector: () => ({ value: 'Launch' }), classList: { add() {} } };
    class Element { closest() { return row; } }
    const inspect = vm.runInNewContext(`${script.slice(start, end)}\ninspectParameter`, {
        HTMLElement: Element, document: { getElementById: (id: string) => id.endsWith('Title') ? title : description, querySelector: () => ({ textContent: 'Vanessa description' }), querySelectorAll: () => [] },
        uiLoc: {}, getBuildParameterDefinition: () => null
    });
    inspect({ target: new Element() });
    assert.equal(title.textContent, 'CreateJson'); assert.equal(description.textContent, 'SPPR description');
});
