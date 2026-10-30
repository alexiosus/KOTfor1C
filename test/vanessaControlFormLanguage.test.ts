import assert from 'node:assert/strict';
import test from 'node:test';
import * as api from '../src/vanessaControlFormLanguage';
import type { BuiltInStepDefinition } from '../src/stepCatalog';
const steps: BuiltInStepDefinition[] = [{ id: 'own', ru: { pattern: 'И я ввожу "%1 Значение" в поле "%2 Имя"', description: '' },
    en: { pattern: 'And I input "%1 Value" in the field named "%2 Name"', description: '' } }];
test('form-check translation uses paired catalog patterns and preserves quoted arguments, tables and docstrings', () => {
    const result = api.translateVanessaFormSteps('И я ввожу \'Русский текст\' в поле "Own"\n  | Русский текст |\nИ текст\n  """\n  И я ввожу "literal" в поле "literal"\n  """', steps, 'en');
    assert.equal(result.text, 'And I input \'Русский текст\' in the field named "Own"\n  | Русский текст |\nИ текст\n  """\n  И я ввожу "literal" в поле "literal"\n  """');
    assert.equal(result.untranslated, 1);
});
test('ambiguous translations are left intact and English invocations are preserved', () => {
    const english = 'And I input "Русский текст" in the field named "Own"';
    assert.equal(api.translateVanessaFormSteps(english, steps, 'en').text, english);
    assert.equal(api.translateVanessaFormSteps(english, steps, 'en').untranslated, 0);
    const ambiguous = [...steps, { ...steps[0], id: 'different', en: { pattern: 'And different "%1 Value" "%2 Name"', description: '' } }];
    const source = 'И я ввожу "Value" в поле "Own"';
    assert.equal(api.translateVanessaFormSteps(source, ambiguous, 'en').text, source);
    assert.equal(api.translateVanessaFormSteps(source, ambiguous, 'en').untranslated, 1);
});
test('a Windows path ending in a backslash is a literal argument, including before the closing quote', () => {
    const text = 'И я ввожу "C:\\tmp\\" в поле "Own"';
    assert.equal(api.translateVanessaFormSteps(text, steps, 'en').text, 'And I input "C:\\tmp\\" in the field named "Own"');
});
