import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as parser from '../src/exportScenarioParser';
import * as matcher from '../src/projectDefinitionMatcher';
import * as compilerSyntax from '../src/scenarioCompilerSyntax';
import * as definitions from '../src/projectDefinition';
import * as keywords from '../src/gherkinDefinitionKeywords';
import type { ProjectDefinition } from '../src/projectDefinition';

const context = {
    sourceUri: 'file:///library/export.feature', workspaceFolderUri: 'file:///repo',
    profileId: 'default', libraryRootUri: 'file:///library', sourceLabel: 'Exports', defaultLanguage: 'en' as const
};

function api(): {
    planFeatureTitleRename: (text: string, expectedTitle: string, title: string) => { before: string; after: string };
    planExportScenarioRename: (source: typeof context & { text: string }, definitionId: string, title: string) => { before: string; after: string };
    renameExportScenarioInvocation: (definition: ProjectDefinition, title: string, invocation: string) => string | null;
    normalizeFeatureRenameFilename: (value: string) => string;
} {
    const file = path.join(process.cwd(), 'src/featureRename.ts');
    const moduleObject = { exports: {} };
    if (fs.existsSync(file)) {
        const ts = require('typescript') as typeof import('typescript');
        const dependencies: Record<string, unknown> = {
            './exportScenarioParser': parser, './projectDefinitionMatcher': matcher,
            './scenarioCompilerSyntax': compilerSyntax, './projectDefinition': definitions,
            './gherkinDefinitionKeywords': keywords
        };
        vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText, { module: moduleObject, exports: moduleObject.exports, require: (name: string) => dependencies[name] });
    }
    assert.equal(typeof (moduleObject.exports as any).planFeatureTitleRename, 'function', 'feature rename is implemented');
    return moduleObject.exports as ReturnType<typeof api>;
}

const source = '#language: en\n@ExportScenarios\nFeature: Exports\n@exampleofuse: Then open "Main" window\nScenario: open "WindowName" window\n    Given ready\nScenario: untouched\n    And ready\n';
const old = parser.parseExportScenarios(source, context).definitions[0];

test('feature rename changes only the real title and preserves BOM, CRLF, spacing and scenarios', () => {
    const text = '\uFEFF#language: en\r\nFeature:   Previous  \r\nScenario: Previous\r\n    Given ready\r\n    """\r\nFeature: payload\r\n    """\r\n';
    assert.equal(api().planFeatureTitleRename(text, 'Previous', 'New title').after,
        text.replace('Feature:   Previous  ', 'Feature:   New title  '));
});

test('feature rename rejects a stale title, empty names and multiline names', () => {
    const rename = api().planFeatureTitleRename;
    assert.throws(() => rename('Feature: Changed\nScenario: A', 'Old', 'New'), /changed|available/iu);
    for (const title of ['', '   ', 'New\nScenario: other', 'New\0title']) {
        assert.throws(() => rename('Feature: Old\nScenario: A', 'Old', title));
    }
});

test('export rename updates the selected declaration and its usage example without changing other scenarios', () => {
    const plan = api().planExportScenarioRename({ ...context, text: source }, old.id, 'activate "WindowName" window');
    assert.equal(plan.after, source.replace('Then open "Main" window', 'Then activate "Main" window')
        .replace('Scenario: open "WindowName" window', 'Scenario: activate "WindowName" window'));
});

test('export invocation rename retains actual quoted values, numeric literals, parameters and the Gherkin prefix', () => {
    const rename = api().renameExportScenarioInvocation;
    for (const value of ['"Main"', "'Main'", '[Window]', '123', '"$Value}"']) {
        assert.equal(rename(old, 'activate "WindowName" window', `\tThen open ${value} window  `), `\tThen activate ${value} window  `);
    }
    assert.equal(rename(old, 'activate "WindowName" window', 'And unrelated call'), null);
});

test('export rename preserves repeated argument values and changes only static parts of the template', () => {
    const text = '#language: en\n@ExportScenarios\nFeature: A\nScenario: copy "Source" into "Target"\n';
    const definition = parser.parseExportScenarios(text, context).definitions[0];
    assert.equal(api().renameExportScenarioInvocation(definition, 'move "Source" to "Target"', 'And copy "copy" into \'Target\''),
        'And move "copy" to \'Target\'');
});

test('export rename cannot change the parameter interface or use a stale declaration identity', () => {
    const rename = api().planExportScenarioRename;
    for (const title of ['activate "Other" window', 'activate window', 'activate "WindowName" "Extra" window']) {
        assert.throws(() => rename({ ...context, text: source }, old.id, title), /parameter/iu);
    }
    assert.throws(() => rename({ ...context, text: source.replace('Scenario: open', 'Scenario: changed') }, old.id, 'activate "WindowName" window'), /changed|available/iu);
});

test('export rename leaves usage-example text in docstrings unchanged', () => {
    const text = source + '    """\n@exampleofuse: Then open "Main" window\n    """\n';
    const plan = api().planExportScenarioRename({ ...context, text }, old.id, 'activate "WindowName" window');
    assert.ok(plan.after.endsWith('    """\n@exampleofuse: Then open "Main" window\n    """\n'));
});

test('feature filename rename supports Unicode, adds the extension and rejects paths and reserved names', () => {
    const normalize = api().normalizeFeatureRenameFilename;
    assert.equal(normalize('  Новая фича  '), 'Новая фича.feature');
    assert.equal(normalize('Smoke.FEATURE'), 'Smoke.FEATURE');
    for (const name of ['', '..', '../file', 'folder/file', 'folder\\file', 'name:other', 'con.feature', 'LPT1', 'bad\0name']) {
        assert.throws(() => normalize(name), /filename/);
    }
});

test('Russian export rename keeps parameter spelling and rejects a duplicate scenario name', () => {
    const text = '#language: ru\n@ExportScenarios\nФункционал: Окна\nСценарий: открыть "ИмяОкна"\nСценарий: активировать "ИмяОкна"\n';
    const current = parser.parseExportScenarios(text, context).definitions[0];
    assert.equal(api().renameExportScenarioInvocation(current, 'показать "ИмяОкна"', '    И открыть \'Основное\''), '    И показать \'Основное\'');
    assert.throws(() => api().planExportScenarioRename({ ...context, text }, current.id, 'активировать "ИмяОкна"'), /already exists/);
});
