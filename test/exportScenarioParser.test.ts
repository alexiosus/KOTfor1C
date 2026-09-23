import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseExportScenarios } from '../src/exportScenarioParser';
import { createProjectDefinitionView } from '../src/projectDefinition';
import { resolveProjectInvocation } from '../src/projectDefinitionMatcher';

const fixtureRoot = path.join(process.cwd(), 'test', 'fixtures', 'project-definitions');

function context(sourceUri: string) {
    return {
        sourceUri,
        workspaceFolderUri: 'file:///workspace',
        profileId: 'active',
        libraryRootUri: 'file:///workspace/libraries',
        sourceLabel: 'Project exports',
        defaultLanguage: 'en' as const
    };
}

test('parses a BOM and CRLF Russian feature-level export without indexing its background', () => {
    const fixture = fs.readFileSync(path.join(fixtureRoot, 'export-ru.feature'), 'utf8').trimEnd();
    const source = `\uFEFF${fixture.replace(/\n/g, '\r\n')}`;
    const result = parseExportScenarios(source, context('file:///workspace/libraries/export-ru.feature'));

    assert.equal(result.language, 'ru');
    assert.equal(result.hasBom, true);
    assert.equal(result.eol, '\r\n');
    assert.equal(result.feature?.hasExportTag, true);
    assert.equal(result.insertion.offset, source.length);
    assert.equal(result.insertion.endsWithEol, false);
    assert.deepEqual(result.definitions.map(item => item.template), [
        'Я открываю карточку "Имя" для "Роль"',
        'Служебный сценарий без параметров'
    ]);
    assert.deepEqual(result.definitions[0].parameters.map(item => item.name), ['Имя', 'Роль']);
    assert.equal(result.definitions[0].description, 'Открывает карточку объекта для выбранной роли.');
    assert.equal(result.definitions[0].language, 'ru');
    assert.equal(result.definitions[0].sourceLabel, 'Project exports');
    assert.equal(result.definitions.some(item => item.template.includes('подготовлены данные')), false);

    const titleLine = source.split('\r\n')[8];
    const range = result.definitions[0].definitionLocation?.range;
    assert.equal(titleLine.slice(range?.start.character, range?.end.character), result.definitions[0].template);
});

test('parses scenario-level English exports, outlines and warnings while ignoring doc strings', () => {
    const source = fs.readFileSync(path.join(fixtureRoot, 'export-en.feature'), 'utf8');
    const result = parseExportScenarios(source, context('file:///workspace/libraries/export-en.feature'));

    assert.equal(result.language, 'en');
    assert.equal(result.hasBom, false);
    assert.equal(result.eol, '\n');
    assert.equal(result.feature?.hasExportTag, false);
    assert.deepEqual(result.definitions.map(item => item.template), [
        'I open <Entity> as "Role"',
        'I pass a document string'
    ]);
    assert.deepEqual(
        result.definitions[0].parameters.map(item => ({ name: item.name, source: item.source })),
        [
            { name: 'Entity', source: 'outline' },
            { name: 'Role', source: 'quoted' }
        ]
    );
    assert.equal(result.definitions.some(item => item.template.includes('Fake declaration')), false);
    assert.equal(result.definitions.some(item => item.template.includes('not exported')), false);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].message, /empty scenario title/i);
});

test('export definitions match calls through the shared matcher', () => {
    const source = fs.readFileSync(path.join(fixtureRoot, 'export-en.feature'), 'utf8');
    const result = parseExportScenarios(source, context('file:///workspace/libraries/export-en.feature'));
    const resolution = resolveProjectInvocation(
        createProjectDefinitionView('exports', result.definitions),
        'And I open Order as "Administrator"'
    );

    assert.equal(resolution.kind, 'unique');
    if (resolution.kind === 'unique') {
        assert.deepEqual(resolution.match.arguments.map(item => item.value), ['Order', 'Administrator']);
    }
});
