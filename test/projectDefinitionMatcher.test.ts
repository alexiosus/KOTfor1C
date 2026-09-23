import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createLocalDefinitionId,
    createProjectDefinitionView,
    normalizeProjectDefinitionTemplate,
    type ProjectDefinition,
    type ProjectDefinitionParameter
} from '../src/projectDefinition';
import {
    compileProjectDefinitionMatcher,
    resolveProjectInvocation
} from '../src/projectDefinitionMatcher';

function makeDefinition(options: {
    id?: string;
    kind?: ProjectDefinition['kind'];
    template: string;
    parameters?: readonly ProjectDefinitionParameter[];
    sourceLabel?: string;
}): ProjectDefinition {
    return {
        id: options.id ?? 'definition-1',
        kind: options.kind ?? 'userStep',
        template: options.template,
        normalizedTemplate: normalizeProjectDefinitionTemplate(options.template),
        parameters: options.parameters ?? [],
        sourceLabel: options.sourceLabel ?? 'Library A'
    };
}

test('normalizes line breaks and whitespace without changing the display template', () => {
    const template = '  И первая\r\n\tвторая   строка  ';
    const definition = makeDefinition({ template });

    assert.equal(definition.template, template);
    assert.equal(definition.normalizedTemplate, 'И первая вторая строка');
});

test('creates stable local ids from definition identity inputs', () => {
    const input = {
        kind: 'userStep' as const,
        sourceUri: 'file:///C:/project/steps.bsl',
        range: {
            start: { line: 4, character: 2 },
            end: { line: 8, character: 5 }
        },
        signature: 'И пользовательский шаг'
    };

    const first = createLocalDefinitionId(input);
    const second = createLocalDefinitionId({ ...input, sourceUri: 'file:\\\\C:\\project\\steps.bsl' });
    const moved = createLocalDefinitionId({
        ...input,
        range: { ...input.range, start: { line: 5, character: 2 } }
    });

    assert.match(first, /^userStep:[a-f0-9]{64}$/);
    assert.equal(second, first);
    assert.notEqual(moved, first);
});

test('matches exact nested scenarios after supported Russian and English keywords', () => {
    const definition = makeDefinition({
        kind: 'nestedScenario',
        template: 'Open form (v2.0) [admin]?'
    });
    const view = createProjectDefinitionView('view-1', [definition]);

    for (const keyword of ['And', 'Given', 'When', 'Then', 'But', 'If', 'И', 'Допустим', 'Когда', 'Тогда', 'Но', 'Если']) {
        const result = resolveProjectInvocation(view, `  * ${keyword} ${definition.template}  `);
        assert.equal(result.kind, 'unique', keyword);
    }

    assert.equal(resolveProjectInvocation(view, `And ${definition.template} extra`).kind, 'missing');
    assert.equal(resolveProjectInvocation(view, `And ${definition.template} # comment`).kind, 'missing');
});

test('matches quoted parameters and preserves argument ranges in the original invocation', () => {
    const definition = makeDefinition({
        template: 'я ввожу "Имя" в поле "Значение"',
        parameters: [
            { name: 'Имя', index: 0, source: 'quoted' },
            { name: 'Значение', index: 1, source: 'quoted' }
        ]
    });
    const invocation = '  И  я ввожу "Логин"  в поле "Администратор"  ';
    const result = resolveProjectInvocation(
        createProjectDefinitionView('view-1', [definition]),
        invocation
    );

    assert.equal(result.kind, 'unique');
    if (result.kind !== 'unique') {
        return;
    }
    assert.deepEqual(result.match.arguments.map(item => item.value), ['Логин', 'Администратор']);
    assert.deepEqual(
        result.match.arguments.map(item => invocation.slice(item.start, item.end)),
        ['Логин', 'Администратор']
    );
});

test('matches Vanessa positional placeholders and outline placeholders in order', () => {
    const positional = makeDefinition({
        id: 'positional',
        template: 'И я выбираю "%1 Поле" со значением "%2 Значение"',
        parameters: [
            { name: 'Поле', index: 0, source: 'snippet' },
            { name: 'Значение', index: 1, source: 'snippet' }
        ]
    });
    const outline = makeDefinition({
        id: 'outline',
        kind: 'exportScenario',
        template: 'Открываю карточку <Имя> для <Роль>',
        parameters: [
            { name: 'Имя', index: 0, source: 'outline' },
            { name: 'Роль', index: 1, source: 'outline' }
        ]
    });

    const positionalResult = compileProjectDefinitionMatcher(positional)
        .match('Тогда я выбираю "Статус" со значением "Активен"');
    const outlineResult = compileProjectDefinitionMatcher(outline)
        .match('И Открываю карточку Контрагент для Администратор');

    assert.deepEqual(positionalResult?.arguments.map(item => item.value), ['Статус', 'Активен']);
    assert.deepEqual(outlineResult?.arguments.map(item => item.value), ['Контрагент', 'Администратор']);
});

test('uses the next repeated literal as the boundary of each parameter', () => {
    const definition = makeDefinition({
        template: 'сравниваю <Лево> с <Право> с результатом',
        parameters: [
            { name: 'Лево', index: 0, source: 'outline' },
            { name: 'Право', index: 1, source: 'outline' }
        ]
    });

    const match = compileProjectDefinitionMatcher(definition)
        .match('И сравниваю один с два с результатом');

    assert.deepEqual(match?.arguments.map(item => item.value), ['один', 'два']);
});

test('does not collapse definitions with the same template and sorts ambiguity deterministically', () => {
    const result = resolveProjectInvocation(
        createProjectDefinitionView('view-1', [
            makeDefinition({ id: 'z', kind: 'userStep', template: 'And shared step', sourceLabel: 'Library Z' }),
            makeDefinition({ id: 'a', kind: 'builtInStep', template: 'And shared step', sourceLabel: 'Vanessa' }),
            makeDefinition({ id: 'b', kind: 'userStep', template: 'And shared step', sourceLabel: 'Library A' })
        ]),
        'And shared step'
    );

    assert.equal(result.kind, 'ambiguous');
    if (result.kind !== 'ambiguous') {
        return;
    }
    assert.deepEqual(result.matches.map(item => item.definition.id), ['a', 'b', 'z']);
});
