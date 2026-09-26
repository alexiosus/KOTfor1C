import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectDefinition } from '../src/projectDefinition';
import {
    buildCallableDefinitionText,
    buildProjectDefinitionInsertion,
    buildProjectDefinitionSnippetData
} from '../src/projectDefinitionSnippet';

function definition(
    overrides: Partial<ProjectDefinition> & Pick<ProjectDefinition, 'template'>
): ProjectDefinition {
    return {
        id: 'definition:test',
        kind: 'builtInStep',
        normalizedTemplate: overrides.template.replace(/\s+/gu, ' ').trim(),
        parameters: [],
        sourceLabel: 'Test definitions',
        ...overrides
    };
}

test('preserves a multiline Vanessa step as display text and snippet tab stops', () => {
    const result = buildProjectDefinitionSnippetData(definition({
        template: 'Then table contains rows\n    | "%1 Column" |'
    }));

    assert.deepEqual(result, {
        displayText: 'Then table contains rows\n    | "" |',
        snippetText: 'Then table contains rows\n    | "${1}" |',
        hasPlaceholders: true
    });
});

test('escapes literal snippet syntax while preserving quoted project parameters', () => {
    const result = buildProjectDefinitionSnippetData(definition({
        kind: 'userStep',
        template: String.raw`And literal C:\\$cache} has value "Example"`,
        parameters: [{ name: 'Value$}', index: 0, source: 'quoted' }]
    }));

    assert.equal(result.displayText, String.raw`And literal C:\\$cache} has value "Example"`);
    assert.equal(
        result.snippetText,
        String.raw`And literal C:\\\\\$cache\} has value "`
            + '${1:Value\\$\\}}'
            + '"'
    );
    assert.equal(result.hasPlaceholders, true);
});

test('turns outline parameters into named snippet placeholders', () => {
    const result = buildProjectDefinitionSnippetData(definition({
        kind: 'exportScenario',
        template: 'When I select <Role> for <User>',
        parameters: [
            { name: 'Role', index: 0, source: 'outline' },
            { name: 'User', index: 1, source: 'outline' }
        ]
    }));

    assert.equal(result.displayText, 'When I select <Role> for <User>');
    assert.equal(result.snippetText, 'When I select ${1:Role} for ${2:User}');
});

test('uses an explicit preferred text such as an export usage example', () => {
    const result = buildProjectDefinitionSnippetData(definition({
        kind: 'exportScenario',
        template: '"WindowName" window is ready',
        usageExample: 'Then "Add indicator" window is ready',
        parameters: [{ name: 'WindowName', index: 0, source: 'quoted' }]
    }), {
        preferredText: 'Then "Add indicator" window is ready'
    });

    assert.equal(result.displayText, 'Then "Add indicator" window is ready');
    assert.equal(result.snippetText, 'Then "${1:WindowName}" window is ready');
});

test('replaces a callable keyword with the typed keyword and otherwise keeps its own keyword', () => {
    assert.equal(
        buildCallableDefinitionText('Then exported action', 'And', 'When'),
        'And exported action'
    );
    assert.equal(
        buildCallableDefinitionText('Then exported action', '', 'When'),
        'Then exported action'
    );
    assert.equal(
        buildCallableDefinitionText('Exported action', '', 'When'),
        'When Exported action'
    );
});

test('builds a nested parameter block with defaults and aligned names', () => {
    const result = buildProjectDefinitionInsertion(definition({
        kind: 'nestedScenario',
        template: 'Create indicator',
        parameters: [
            { name: 'Filters', index: 0, source: 'snippet' },
            { name: 'Title', index: 1, source: 'snippet', defaultValue: '"Sales"' }
        ]
    }), {
        fallbackKeyword: 'And',
        language: 'en',
        parameterDefaults: { Filters: '"Filters"' }
    });

    assert.deepEqual(result, {
        displayText: 'And Create indicator\n    Filters = "Filters"\n    Title   = "Sales"',
        snippetText: 'And Create indicator\n    Filters = ${1:"Filters"}\n    Title   = ${2:"Sales"}',
        hasPlaceholders: true
    });
});

test('builds export insertion from its usage example and typed keyword', () => {
    const result = buildProjectDefinitionInsertion(definition({
        kind: 'exportScenario',
        template: '"WindowName" window is ready',
        usageExample: 'Then "Add indicator" window is ready',
        parameters: [{ name: 'WindowName', index: 0, source: 'quoted' }]
    }), {
        typedKeyword: 'And',
        fallbackKeyword: 'Then',
        language: 'en'
    });

    assert.equal(result.displayText, 'And "Add indicator" window is ready');
    assert.equal(result.snippetText, 'And "${1:WindowName}" window is ready');
    assert.equal(result.hasPlaceholders, true);
});
