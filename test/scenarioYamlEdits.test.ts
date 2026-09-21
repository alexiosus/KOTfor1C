import assert from 'node:assert/strict';
import test from 'node:test';
import * as scenarioYamlMutations from '../src/scenarioYamlMutations';
import {
    getSectionBodyReplacement,
    getSectionInsertion,
    type SourceEdit
} from '../src/scenarioYamlDocument';
import {
    updateNestedScenarioNameReferencesInScenarioContent,
    updateScenarioDisplayNameInScenarioContent,
    updateScenarioDisplayNameInTestConfigContent,
    updateScenarioGroupInMetadataContent
} from '../src/scenarioYamlMutations';

function applyEdit(source: string, edit: SourceEdit): string {
    return source.slice(0, edit.range.start) + edit.text + source.slice(edit.range.end);
}

test('YAML section insertion appends a nested scenario and preserves CRLF and comments', () => {
    const source = [
        'ТипФайла: Сценарий',
        'ВложенныеСценарии:',
        '  # этот комментарий остается',
        '    - ВложенныеСценарии1:',
        '        UIDВложенныйСценарий: "uid-1"',
        '        ИмяСценария: "Первый"',
        'ТекстСценария: |',
        '    И Первый',
        ''
    ].join('\r\n');

    const edit = getSectionInsertion(source, 'ВложенныеСценарии', [
        '- ВложенныеСценарии2:',
        '    UIDВложенныйСценарий: "uid-2"',
        '    ИмяСценария: "Второй"'
    ].join('\n'));

    assert.ok(edit);
    assert.equal(applyEdit(source, edit), [
        'ТипФайла: Сценарий',
        'ВложенныеСценарии:',
        '  # этот комментарий остается',
        '    - ВложенныеСценарии1:',
        '        UIDВложенныйСценарий: "uid-1"',
        '        ИмяСценария: "Первый"',
        '    - ВложенныеСценарии2:',
        '        UIDВложенныйСценарий: "uid-2"',
        '        ИмяСценария: "Второй"',
        'ТекстСценария: |',
        '    И Первый',
        ''
    ].join('\r\n'));
});

test('YAML section insertion fills an empty section before adjacent comments', () => {
    const source = 'ВложенныеСценарии:\n# пояснение следующей секции\nТекстСценария: |\n    И Сценарий\n';
    const edit = getSectionInsertion(
        source,
        'ВложенныеСценарии',
        '- ВложенныеСценарии1:\n    ИмяСценария: "Сценарий"'
    );

    assert.ok(edit);
    assert.equal(applyEdit(source, edit), [
        'ВложенныеСценарии:',
        '    - ВложенныеСценарии1:',
        '        ИмяСценария: "Сценарий"',
        '# пояснение следующей секции',
        'ТекстСценария: |',
        '    И Сценарий',
        ''
    ].join('\n'));
});

test('YAML section replacement changes only nested-scenario items', () => {
    const source = [
        'ТипФайла: Сценарий',
        'ВложенныеСценарии:',
        '  # описание списка',
        '    - ВложенныеСценарии1:',
        '        ИмяСценария: "Старый"',
        '# комментарий следующей секции',
        'ТекстСценария: |',
        '    И Новый',
        ''
    ].join('\n');
    const edit = getSectionBodyReplacement(
        source,
        'ВложенныеСценарии',
        '- ВложенныеСценарии1:\n    ИмяСценария: "Новый"'
    );

    assert.ok(edit);
    const result = applyEdit(source, edit);
    assert.equal(result, [
        'ТипФайла: Сценарий',
        'ВложенныеСценарии:',
        '  # описание списка',
        '    - ВложенныеСценарии1:',
        '        ИмяСценария: "Новый"',
        '# комментарий следующей секции',
        'ТекстСценария: |',
        '    И Новый',
        ''
    ].join('\n'));
    assert.equal(result.slice(0, edit.range.start), source.slice(0, edit.range.start));
    assert.equal(result.slice(edit.range.start + edit.text.length), source.slice(edit.range.end));
});

test('YAML section replacement supports inline empty sequences', () => {
    const source = 'ВложенныеСценарии: []\nТекстСценария: |\n    И Сценарий\n';
    const edit = getSectionBodyReplacement(
        source,
        'ВложенныеСценарии',
        '- ВложенныеСценарии1:\n    ИмяСценария: "Сценарий"'
    );

    assert.ok(edit);
    assert.equal(applyEdit(source, edit), [
        'ВложенныеСценарии:',
        '    - ВложенныеСценарии1:',
        '        ИмяСценария: "Сценарий"',
        'ТекстСценария: |',
        '    И Сценарий',
        ''
    ].join('\n'));
});

test('YAML inline empty section preserves its trailing comment', () => {
    const source = 'ВложенныеСценарии: [] # оставить комментарий\nТекстСценария: |\n    И Сценарий\n';
    const edit = getSectionInsertion(
        source,
        'ВложенныеСценарии',
        '- ВложенныеСценарии1:\n    ИмяСценария: "Сценарий"'
    );

    assert.ok(edit);
    assert.equal(applyEdit(source, edit), [
        'ВложенныеСценарии: # оставить комментарий',
        '    - ВложенныеСценарии1:',
        '        ИмяСценария: "Сценарий"',
        'ТекстСценария: |',
        '    И Сценарий',
        ''
    ].join('\n'));
});

test('YAML section edits reject non-empty or malformed inline values', () => {
    for (const value of ['[{existing: value}]', '[broken']) {
        assert.throws(
            () => getSectionInsertion(
                `ВложенныеСценарии: ${value}\nТекстСценария: |\n    И Сценарий\n`,
                'ВложенныеСценарии',
                '- ВложенныеСценарии1:\n    ИмяСценария: "Новый"'
            ),
            /Unsafe YAML edit/i
        );
    }
});

test('YAML section replacement preserves parameter neighbors and quoted punctuation', () => {
    const source = [
        'ДанныеСценария:',
        '  Имя: Тест',
        'ПараметрыСценария:',
        '    - ПараметрыСценария1:',
        '        Имя: Старый',
        '        Значение: "A: #1"',
        'ВложенныеСценарии:',
        '    - ВложенныеСценарии1:',
        '        ИмяСценария: Сосед',
        'ТекстСценария: |',
        '    И Сосед',
        ''
    ].join('\n');
    const edit = getSectionBodyReplacement(source, 'ПараметрыСценария', [
        '- ПараметрыСценария1:',
        '    Имя: "Новый"',
        '    Значение: "B: #2"'
    ].join('\n'));

    assert.ok(edit);
    assert.equal(applyEdit(source, edit), [
        'ДанныеСценария:',
        '  Имя: Тест',
        'ПараметрыСценария:',
        '    - ПараметрыСценария1:',
        '        Имя: "Новый"',
        '        Значение: "B: #2"',
        'ВложенныеСценарии:',
        '    - ВложенныеСценарии1:',
        '        ИмяСценария: Сосед',
        'ТекстСценария: |',
        '    И Сосед',
        ''
    ].join('\n'));
});

test('YAML section edits refuse malformed documents and ignore missing sections', () => {
    assert.throws(
        () => getSectionBodyReplacement(
            'ВложенныеСценарии:\n    - ВложенныеСценарии1:\n        ИмяСценария: Тест\n  - structural error\n',
            'ВложенныеСценарии',
            ''
        ),
        /YAML/i
    );
    assert.equal(getSectionInsertion('ДанныеСценария:\n  Имя: Тест\n', 'ВложенныеСценарии', '- item'), null);
});

test('scenario group mutation changes only PhaseSwitcher.Tab and preserves formatting', () => {
    const source = [
        '\uFEFFТипФайла: Сценарий',
        'Tab: "Не менять"',
        'KOTМетаданные:',
        '    PhaseSwitcher:',
        '        # комментарий остается',
        "        Tab: 'Старая' # хвост остается",
        '    Описание: |',
        '        Tab: тоже не менять',
        ''
    ].join('\r\n');

    assert.deepEqual(updateScenarioGroupInMetadataContent(source, 'Новая: "группа" #1'), {
        changed: true,
        content: [
            '\uFEFFТипФайла: Сценарий',
            'Tab: "Не менять"',
            'KOTМетаданные:',
            '    PhaseSwitcher:',
            '        # комментарий остается',
            '        Tab: "Новая: \\"группа\\" #1" # хвост остается',
            '    Описание: |',
            '        Tab: тоже не менять',
            ''
        ].join('\r\n')
    });
});

test('scenario group insertion follows legacy metadata description body', () => {
    const source = [
        'KOTМетаданные:',
        '    Описание: |',
        '        Пояснение сценария',
        '        - произвольный текст',
        'ПараметрыСценария:',
        '    - ПараметрыСценария1:',
        '        Имя: Значение',
        ''
    ].join('\n');

    const result = updateScenarioGroupInMetadataContent(source, 'Новая группа');
    assert.equal(result.content, [
        'KOTМетаданные:',
        '    Описание: |',
        '        Пояснение сценария',
        '        - произвольный текст',
        '    PhaseSwitcher:',
        '        Tab: "Новая группа"',
        'ПараметрыСценария:',
        '    - ПараметрыСценария1:',
        '        Имя: Значение',
        ''
    ].join('\n'));
});

test('scenario group mutation creates a missing PhaseSwitcher mapping', () => {
    const source = [
        'KOTМетаданные:',
        '    Версия: 1',
        '# следующий раздел',
        'ТекстСценария: |',
        '    И шаг',
        ''
    ].join('\n');

    assert.deepEqual(updateScenarioGroupInMetadataContent(source, 'Новая группа'), {
        changed: true,
        content: [
            'KOTМетаданные:',
            '    Версия: 1',
            '    PhaseSwitcher:',
            '        Tab: "Новая группа"',
            '# следующий раздел',
            'ТекстСценария: |',
            '    И шаг',
            ''
        ].join('\n')
    });
});

test('scenario group mutation adds Tab to an existing PhaseSwitcher mapping', () => {
    const source = [
        'KOTМетаданные:',
        '    PhaseSwitcher:',
        '        Порядок: 10',
        '    Версия: 1',
        ''
    ].join('\n');

    assert.deepEqual(updateScenarioGroupInMetadataContent(source, 'Группа'), {
        changed: true,
        content: [
            'KOTМетаданные:',
            '    PhaseSwitcher:',
            '        Порядок: 10',
            '        Tab: "Группа"',
            '    Версия: 1',
            ''
        ].join('\n')
    });
});

test('scenario group mutation rejects a scalar PhaseSwitcher value', () => {
    const source = [
        'KOTМетаданные:',
        '    PhaseSwitcher: disabled',
        ''
    ].join('\n');

    assert.throws(
        () => updateScenarioGroupInMetadataContent(source, 'Группа'),
        /Unsafe YAML edit/i
    );
});

test('scenario mutations reject non-scalar and ambiguous target nodes', () => {
    const unsafeGroupSources = [
        [
            'KOTМетаданные:',
            '    PhaseSwitcher:',
            '        - disabled',
            ''
        ].join('\n'),
        [
            'KOTМетаданные:',
            '    PhaseSwitcher:',
            '        Tab:',
            '            nested: value',
            ''
        ].join('\n'),
        [
            'KOTМетаданные:',
            '    PhaseSwitcher:',
            '        Tab: Первая',
            '        Tab: Вторая',
            ''
        ].join('\n')
    ];
    for (const source of unsafeGroupSources) {
        assert.throws(
            () => updateScenarioGroupInMetadataContent(source, 'Группа'),
            /Unsafe YAML edit/i
        );
    }

    for (const unsafeName of ['[Старое]', '|\n        Старое', 'null']) {
        const source = `ДанныеСценария:\n    Имя: ${unsafeName}\n`;
        assert.throws(
            () => updateScenarioDisplayNameInScenarioContent(source, 'Новое'),
            /Unsafe YAML edit/i
        );
    }
});

test('identity mutation refuses duplicate scenario sections even when the first omits the target', () => {
    const source = [
        'ДанныеСценария:',
        '    UID: first',
        'ДанныеСценария:',
        '    Имя: Старое',
        ''
    ].join('\n');

    assert.throws(
        () => updateScenarioDisplayNameInScenarioContent(source, 'Новое'),
        /Unsafe YAML edit/i
    );
});

test('scenario identity mutation updates only DataScenario scalar values', () => {
    const source = [
        'ДанныеСценария:',
        "    Имя: 'Старое имя' # сохранить имя",
        '    Код: OLD # сохранить код',
        'KOTМетаданные:',
        '    Имя: "Не менять"',
        ''
    ].join('\n');

    assert.deepEqual(updateScenarioDisplayNameInScenarioContent(source, 'Новое: "имя"', 'NEW#1'), {
        changed: true,
        content: [
            'ДанныеСценария:',
            '    Имя: "Новое: \\"имя\\"" # сохранить имя',
            '    Код: "NEW#1" # сохранить код',
            'KOTМетаданные:',
            '    Имя: "Не менять"',
            ''
        ].join('\n')
    });
});

test('test identity mutation does not rewrite matching keys outside DataTest', () => {
    const source = [
        'ДанныеТеста:',
        '    Имя: Старое # имя теста',
        '    СценарийНаименование: Старое # имя сценария',
        '    Код: OLD # код сценария',
        'ПараметрыСценария:',
        '    - ПараметрыСценария1:',
        '        Имя: Не менять',
        '        Код: KEEP',
        ''
    ].join('\n');

    assert.deepEqual(updateScenarioDisplayNameInTestConfigContent(source, 'Новое имя', 'NEW'), {
        changed: true,
        content: [
            'ДанныеТеста:',
            '    Имя: "Новое имя" # имя теста',
            '    СценарийНаименование: "Новое имя" # имя сценария',
            '    Код: "NEW" # код сценария',
            'ПараметрыСценария:',
            '    - ПараметрыСценария1:',
            '        Имя: Не менять',
            '        Код: KEEP',
            ''
        ].join('\n')
    });
});

test('nested scenario mutation updates exact calls and record fields only', () => {
    const source = [
        'ВложенныеСценарии:',
        '    - ВложенныеСценарии1:',
        "        ИмяСценария: 'Старый' # комментарий остается",
        '        Имя: Старый',
        '    - ВложенныеСценарии2:',
        '        ИмяСценария: Старый',
        '    - ВложенныеСценарии3:',
        '        ИмяСценария: "Старый хвост"',
        'ТекстСценария: |',
        '    И Старый # вызов',
        '    Когда Старый хвост',
        '    Тогда параметр "Старый"',
        ''
    ].join('\n');

    assert.deepEqual(updateNestedScenarioNameReferencesInScenarioContent(
        source,
        'Старый',
        'Новый сценарий'
    ), {
        changed: true,
        updatedCallCount: 1,
        updatedNestedSectionCount: 2,
        content: [
            'ВложенныеСценарии:',
            '    - ВложенныеСценарии1:',
            '        ИмяСценария: "Новый сценарий" # комментарий остается',
            '        Имя: Старый',
            '    - ВложенныеСценарии2:',
            '        ИмяСценария: "Новый сценарий"',
            '    - ВложенныеСценарии3:',
            '        ИмяСценария: "Старый хвост"',
            'ТекстСценария: |',
            '    И Новый сценарий # вызов',
            '    Когда Старый хвост',
            '    Тогда параметр "Старый"',
            ''
        ].join('\n')
    });
});

test('nested scenario mutation requires a Gherkin block and strict record shape', () => {
    const nonBlockText = [
        'ВложенныеСценарии: []',
        'ТекстСценария:',
        '    И: Старый',
        ''
    ].join('\n');
    assert.throws(
        () => updateNestedScenarioNameReferencesInScenarioContent(nonBlockText, 'Старый', 'Новый'),
        /Unsafe YAML edit/i
    );

    const directRecord = [
        'ВложенныеСценарии:',
        '    - ИмяСценария: Старый',
        'ТекстСценария: |',
        '    И Старый',
        ''
    ].join('\n');
    assert.throws(
        () => updateNestedScenarioNameReferencesInScenarioContent(directRecord, 'Старый', 'Новый'),
        /Unsafe YAML edit/i
    );
});

test('nested rename planning validates every source before returning a write plan', () => {
    type RenameSource = { key: string; content: string; renameSelf?: boolean };
    type RenamePlan = (
        sources: readonly RenameSource[],
        oldName: string,
        newName: string
    ) => readonly unknown[];
    const planRename = (scenarioYamlMutations as typeof scenarioYamlMutations & {
        planNestedScenarioRename?: RenamePlan;
    }).planNestedScenarioRename;
    assert.equal(typeof planRename, 'function');

    const sources: RenameSource[] = [
        {
            key: 'first',
            renameSelf: true,
            content: [
                'ДанныеСценария:',
                '    Имя: Старый',
                'ВложенныеСценарии: []',
                'ТекстСценария: |',
                '    И Старый',
                ''
            ].join('\n')
        },
        {
            key: 'unsafe-later-source',
            content: [
                'ВложенныеСценарии: []',
                'ТекстСценария:',
                '    И: Старый',
                ''
            ].join('\n')
        }
    ];

    assert.throws(
        () => planRename!(sources, 'Старый', 'Новый'),
        /Unsafe YAML edit/i
    );
});

test('nested rename planning yields during a large preflight without publishing partial plans', async () => {
    const source = 'ВложенныеСценарии: []\nТекстСценария: |\n    И Старый\n';
    const sources = Array.from({ length: 33 }, (_, index) => ({ key: index, content: source }));
    let yields = 0;
    const plan = await scenarioYamlMutations.planNestedScenarioRenameInChunks(
        sources,
        'Старый',
        'Новый',
        async () => { yields += 1; }
    );

    assert.equal(yields, 1);
    assert.equal(plan.length, sources.length);
    assert.ok(plan.every(item => item.before === source && item.updatedCallCount === 1));
});

test('group rename planning rejects a later unsafe source before returning writes', () => {
    type GroupSource = { key: string; content: string };
    type GroupPlan = (
        sources: readonly GroupSource[],
        groupName: string
    ) => readonly unknown[];
    const planRename = (scenarioYamlMutations as typeof scenarioYamlMutations & {
        planScenarioGroupRename?: GroupPlan;
    }).planScenarioGroupRename;
    assert.equal(typeof planRename, 'function');

    const sources: GroupSource[] = [
        {
            key: 'first',
            content: [
                'KOTМетаданные:',
                '    PhaseSwitcher:',
                '        Tab: Старая',
                ''
            ].join('\n')
        },
        {
            key: 'unsafe-later-source',
            content: [
                'KOTМетаданные:',
                '    PhaseSwitcher:',
                '        Tab: Первая',
                '        Tab: Вторая',
                ''
            ].join('\n')
        }
    ];

    assert.throws(
        () => planRename!(sources, 'Новая'),
        /Unsafe YAML edit/i
    );
});

test('group rename plan retains the original bytes when metadata was prepared in memory', () => {
    const source = 'KOTМетаданные:\n    Tab: Старая\n';
    const prepared = 'KOTМетаданные:\n    PhaseSwitcher:\n        Tab: Старая\n';
    const plan = scenarioYamlMutations.planScenarioGroupRename([{
        key: 'scenario',
        content: source,
        preparedContent: prepared
    }], 'Новая');

    assert.deepEqual(plan, [{
        key: 'scenario',
        before: source,
        content: 'KOTМетаданные:\n    PhaseSwitcher:\n        Tab: "Новая"\n',
        changed: true
    }]);
});

test('identity rename planning validates test configs before filesystem renames', () => {
    type IdentitySource = { key: string; content: string; kind: 'scenario' | 'test' };
    type IdentityPlan = (
        sources: readonly IdentitySource[],
        scenarioName: string,
        scenarioCode?: string
    ) => readonly unknown[];
    const planRename = (scenarioYamlMutations as typeof scenarioYamlMutations & {
        planScenarioIdentityRename?: IdentityPlan;
    }).planScenarioIdentityRename;
    assert.equal(typeof planRename, 'function');

    const sources: IdentitySource[] = [
        {
            key: 'scenario',
            kind: 'scenario',
            content: 'ДанныеСценария:\n    Имя: Старое\n    Код: OLD\n'
        },
        {
            key: 'unsafe-test',
            kind: 'test',
            content: 'ДанныеТеста:\n    Имя: |\n        Старое\n'
        }
    ];

    assert.throws(
        () => planRename!(sources, 'Новое', 'NEW'),
        /Unsafe YAML edit/i
    );
});
