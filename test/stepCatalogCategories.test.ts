import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createStepDefinitionId,
    type BuiltInStepDefinition
} from '../src/stepCatalog';
import { enrichStepCatalogCategories } from '../src/stepCatalogCategories';

function step(ru: string, en?: string): BuiltInStepDefinition {
    return {
        id: createStepDefinitionId(ru, en),
        ru: { pattern: ru, description: `Description: ${ru}` },
        ...(en ? { en: { pattern: en, description: `Description: ${en}` } } : {})
    };
}

function registration(template: string, category?: string) {
    return { template, category };
}

test('enriches by normalized Russian template and translates dotted path segments', () => {
    const result = enrichStepCatalogCategories({
        steps: [step('И открываю форму', 'And I open form')],
        categoryTranslations: [
            { ru: 'Интерфейс.Формы', en: 'UI.Forms' }
        ],
        registrations: [registration('  И открываю форму\r\n', ' Интерфейс . Формы ')]
    });

    assert.deepEqual(result.steps[0].categoryPath, {
        ru: ['Интерфейс', 'Формы'],
        en: ['UI', 'Forms']
    });
    assert.deepEqual(result.report, {
        categorizedStepCount: 1,
        uncategorizedStepCount: 0,
        unmatchedRegistrationCount: 0,
        conflictingCategoryMappings: [],
        untranslatableCategorySegments: []
    });
});

test('matches registration examples to catalog placeholders using the executable first line', () => {
    const result = enrichStepCatalogCategories({
        steps: [step(
            'И я запоминаю значение поля "%1 ИмяПоля" в буфер обмена',
            'And I save "%1 FieldName" field value to the clipboard'
        )],
        categoryTranslations: [{ ru: 'Прочее.Буфер обмена', en: 'Other.Clipboard' }],
        registrations: [registration(
            'И я запоминаю значение поля "ИмяПоля" в буфер обмена\n    | table |',
            'Прочее.Буфер обмена'
        )]
    });

    assert.deepEqual(result.steps[0].categoryPath, {
        ru: ['Прочее', 'Буфер обмена'],
        en: ['Other', 'Clipboard']
    });
    assert.equal(result.report.unmatchedRegistrationCount, 0);
});

test('collapses repeated identical mappings and leaves conflicting mappings uncategorized', () => {
    const repeated = step('И повторяемый шаг');
    const conflicting = step('И конфликтный шаг');
    const untouched = step('И шаг без регистрации');
    const result = enrichStepCatalogCategories({
        steps: [repeated, conflicting, untouched],
        categoryTranslations: [],
        registrations: [
            registration('И повторяемый шаг', 'Общее.Данные'),
            registration('И повторяемый шаг', 'Общее.Данные'),
            registration('И конфликтный шаг', 'A'),
            registration('И конфликтный шаг', 'B'),
            registration('И шаг без категории')
        ]
    });

    assert.deepEqual(result.steps[0].categoryPath, { ru: ['Общее', 'Данные'] });
    assert.equal(result.steps[1].categoryPath, undefined);
    assert.equal(result.steps[2].categoryPath, undefined);
    assert.deepEqual(result.steps.map(item => item.id), [
        repeated.id,
        conflicting.id,
        untouched.id
    ]);
    assert.deepEqual(result.report.conflictingCategoryMappings, ['И конфликтный шаг']);
    assert.equal(result.report.categorizedStepCount, 1);
    assert.equal(result.report.uncategorizedStepCount, 2);
});

test('reports unmatched registrations and missing or conflicting category translations deterministically', () => {
    const result = enrichStepCatalogCategories({
        steps: [
            step('И шаг A', 'And step A'),
            step('И шаг B', 'And step B')
        ],
        categoryTranslations: [
            { ru: 'Интерфейс', en: 'UI' },
            { ru: 'Формы', en: 'Forms' },
            { ru: 'Формы', en: 'Windows' }
        ],
        registrations: [
            registration('И шаг A', 'Интерфейс.Формы'),
            registration('И шаг B', 'Неизвестно'),
            registration('И отсутствующий шаг', 'Данные'),
            registration('И ещё один отсутствующий шаг', 'Данные')
        ]
    });

    assert.deepEqual(result.steps.map(item => item.categoryPath), [
        { ru: ['Интерфейс', 'Формы'] },
        { ru: ['Неизвестно'] }
    ]);
    assert.equal(result.report.unmatchedRegistrationCount, 2);
    assert.deepEqual(result.report.untranslatableCategorySegments, [
        'Неизвестно',
        'Формы'
    ]);
    assert.equal(result.steps.length, 2);
});

test('applies one category mapping to every catalog variant sharing its Russian template', () => {
    const result = enrichStepCatalogCategories({
        steps: [
            step('И общий шаг', 'And common step'),
            step('И общий шаг', 'When common step')
        ],
        categoryTranslations: [{ ru: 'Общее', en: 'Common' }],
        registrations: [registration('И общий шаг', 'Общее')]
    });

    assert.equal(result.steps.length, 2);
    assert.deepEqual(result.steps.map(item => item.categoryPath), [
        { ru: ['Общее'], en: ['Common'] },
        { ru: ['Общее'], en: ['Common'] }
    ]);
});
