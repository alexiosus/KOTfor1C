import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { parseScenarioDescriptor, type ParsedScenarioDescriptor } from '../src/scenarioDescriptor';
import { parseExportScenarios, validateGherkinSyntax } from '../src/exportScenarioParser';
import { parseUserStepSource } from '../src/bslStepSourceParser';
import { collectCompilerParameterReferences, getCompilerScenarioBody } from '../src/scenarioCompilerSyntax';

const root = path.resolve('examples/kot-workshop');
const localDirectories = new Set([
    path.join(root, '.vscode', 'kot-runtime'),
    path.join(root, 'build'),
    path.join(root, 'tools')
]);
function files(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const target = path.join(directory, entry.name);
        if (localDirectories.has(target)) { return []; }
        return entry.isDirectory() ? files(target) : [target];
    });
}
const allFiles = files(root);
const source = (file: string) => fs.readFileSync(file, 'utf8');
function yaml(file: string): Record<string, any> {
    const document = parseDocument(source(file), { uniqueKeys: true });
    assert.deepEqual(document.errors, [], `Invalid YAML: ${file}`);
    return document.toJS() as Record<string, any>;
}
for (const file of allFiles.filter(file => /\.(?:ya?ml)$/u.test(file))) { yaml(file); }
for (const file of allFiles.filter(file => /\.(?:json|code-workspace)$/u.test(file))) { JSON.parse(source(file)); }

const scenarios = new Map<string, { file: string; descriptor: ParsedScenarioDescriptor }>();
const codes = new Set<string>();
for (const file of allFiles.filter(file => /(?:scen|meta|process)\.yaml$/u.test(file))) {
    const descriptor = parseScenarioDescriptor(source(file));
    assert.ok(descriptor.uid && descriptor.name && descriptor.scenarioCode, `Missing identity: ${file}`);
    assert.ok(!scenarios.has(descriptor.uid), `Duplicate UID: ${file}`);
    assert.ok(!codes.has(descriptor.scenarioCode), `Duplicate code: ${file}`);
    codes.add(descriptor.scenarioCode);
    scenarios.set(descriptor.uid, { file, descriptor });
    const script = path.basename(file) === 'meta.yaml' ? path.join(path.dirname(file), 'scen.feature') : undefined;
    if (script) {
        assert.ok(fs.existsSync(script), `Missing paired script: ${file}`);
        assert.ok(!Object.hasOwn(yaml(file), 'ТекстСценария'), `Native metadata contains a script: ${file}`);
    }
    const body = script ? source(script).split('\n') : getCompilerScenarioBody(source(file))?.lines ?? [];
    for (const parameter of collectCompilerParameterReferences(body)) {
        assert.ok(descriptor.parameters?.includes(parameter), `Undeclared parameter ${parameter}: ${file}`);
    }
}
assert.equal(scenarios.size, 7, 'Expected five SPPR scenarios and two processes');
const names = new Set([...scenarios.values()].map(item => item.descriptor.name));
for (const { file, descriptor } of scenarios.values()) {
    for (const name of descriptor.nestedScenarioNames ?? []) { assert.ok(names.has(name), `Unknown nested definition ${name}: ${file}`); }
    for (const step of descriptor.processSteps ?? []) {
        const target = step.type === 'process' ? step.processUid : step.scenarioUid;
        assert.ok(target && scenarios.has(target), `Unknown process step target: ${file}`);
    }
}
const runSettings = allFiles.filter(file => path.basename(path.dirname(file)) === 'test' && file.endsWith('.yaml'));
assert.equal(runSettings.length, 5);
const settingsUids = new Set<string>();
for (const file of runSettings) {
    const data = yaml(file).ДанныеТеста;
    assert.ok(data?.UID && !settingsUids.has(data.UID), `Duplicate run-settings UID: ${file}`);
    settingsUids.add(data.UID);
    assert.ok(scenarios.has(data.UIDСценария ?? data.UIDПроцесса), `Missing linked source: ${file}`);
}
const groups = new Set(yaml(path.join(root, '.kot/groups.yml')).groups.map((group: { id: string }) => group.id));
for (const file of allFiles.filter(file => file.endsWith('.kot.yml'))) {
    const metadata = yaml(file);
    assert.equal(metadata.version, 2);
    assert.ok(groups.has(metadata.metadata.groupId), `Unknown group: ${file}`);
    assert.ok(fs.existsSync(file.slice(0, -'.kot.yml'.length)), `Orphan metadata: ${file}`);
    if (metadata.identity.uid) { assert.ok(scenarios.has(metadata.identity.uid), `Unknown sidecar identity: ${file}`); }
}
const context = (file: string) => ({ sourceUri: pathToFileURL(file).href, workspaceFolderUri: pathToFileURL(root).href,
    profileId: 'workshop', libraryRootUri: pathToFileURL(path.join(root, 'libraries')).href, sourceLabel: 'Workshop' });
for (const file of allFiles.filter(file => file.endsWith('.feature'))) {
    const fragment = path.basename(file) === 'scen.feature';
    assert.deepEqual(validateGherkinSyntax(source(file), pathToFileURL(file).href, fragment), [], `Invalid Gherkin: ${file}`);
}
const library = path.join(root, 'libraries/workshop.feature');
const exports = parseExportScenarios(source(library), { ...context(library), defaultLanguage: 'en' });
assert.equal(exports.definitions.length, 1);
const bsl = path.join(root, 'libraries/user-steps/WorkshopSteps.bsl');
assert.equal(parseUserStepSource(source(bsl), context(bsl)).definitions.length, 1, 'User step must be indexed by KOT');

let links = 0;
for (const file of allFiles.filter(file => file.endsWith('.md'))) {
    for (const match of source(file).matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
        const target = match[1].split('#')[0];
        if (!target || /^[a-z][a-z\d+.-]*:/iu.test(target)) { continue; }
        assert.ok(fs.existsSync(path.resolve(path.dirname(file), decodeURIComponent(target))), `Broken link ${target}: ${file}`);
        links++;
    }
}
console.log(`Workshop verified: ${scenarios.size} SPPR sources, ${runSettings.length} run settings, 3 standalone features, 1 export, 1 user step, ${links} local guide links.`);
console.log('This checks source integrity. Live compilation and execution require a configured 1C/Vanessa environment.');

const prototypeRoot = path.resolve('docs/ux/first-run');
const settingsMap = JSON.parse(source(path.join(prototypeRoot, 'settings-map.json'))) as {
    sections: Array<{ id: string }>;
    settings: Array<{ key: string; label: string; section: string; default: unknown; type: unknown; enum?: unknown; itemEnum?: unknown }>;
};
const manifest = JSON.parse(source(path.resolve('package.json'))) as {
    contributes: { configuration: Array<{ properties: Record<string, { type: unknown; default?: unknown; enum?: unknown; items?: { enum?: unknown } }> }> };
};
const properties = Object.assign({}, ...manifest.contributes.configuration.map(section => section.properties)) as Record<string, { type: unknown; default?: unknown; enum?: unknown; items?: { enum?: unknown } }>;
assert.equal(new Set(settingsMap.settings.map(item => item.key)).size, settingsMap.settings.length, 'Duplicate settings-map keys');
assert.deepEqual(new Set(settingsMap.settings.map(item => item.key)), new Set(Object.keys(properties)), 'Settings map must cover the complete manifest');
for (const item of settingsMap.settings) {
    assert.ok(item.label && settingsMap.sections.some(section => section.id === item.section));
    assert.deepEqual(item.default, properties[item.key].default ?? null, `Changed default: ${item.key}`);
    assert.deepEqual(item.type, properties[item.key].type, `Changed type: ${item.key}`);
    assert.deepEqual(item.enum, properties[item.key].enum, `Changed enum: ${item.key}`);
    assert.deepEqual(item.itemEnum, properties[item.key].items?.enum, `Changed array choices: ${item.key}`);
}
const snapshot = source(path.join(prototypeRoot, 'settings-data.js'));
const prefix = 'window.KOT_SETTINGS_MODEL = ';
assert.deepEqual(JSON.parse(snapshot.slice(snapshot.indexOf(prefix) + prefix.length).trim().replace(/;$/u, '')), settingsMap,
    'Standalone prototype snapshot must match settings-map.json');
console.log(`Settings design verified: ${settingsMap.settings.length} existing keys, ${settingsMap.sections.length} sections, unchanged types/defaults/enums.`);
