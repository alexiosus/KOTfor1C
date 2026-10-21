import assert from 'node:assert/strict';
import test from 'node:test';
import { alignGherkinTablesInText } from '../src/gherkinTableUtils';

test('feature tables align cells and keep escaped pipes inside their cell', () => {
    const source = 'Feature: Own\nScenario: Own\n  And table\n    | Name | Value |\n    | A\\|B | 1 |\n    | Longer | 22 |\n';
    const aligned = alignGherkinTablesInText(source, '\n');
    assert.ok(aligned.includes('      | A\\|B   | 1     |'));
    assert.equal(aligned.match(/^\s*\|.*\|$/gmu)?.length, 3);
    assert.equal(alignGherkinTablesInText(aligned, '\n'), aligned);
});

test('formatting a feature does not modify table-looking docstrings or block comments', () => {
    for (const delimiter of ['"""', "'''", '```']) {
        const literal = `  ${delimiter}\n    | X |Long |\n    | Longer | x |\n  ${delimiter}`;
        const source = `Feature: Own\nScenario: Own\n  And text\n${literal}\n/*\n| A |  B |\n*/\n  And table\n    | A |Long|\n    | Longer | x |\n`;
        const aligned = alignGherkinTablesInText(source, '\n');
        assert.ok(aligned.includes(literal)); assert.ok(aligned.includes('/*\n| A |  B |\n*/'));
        assert.notEqual(aligned, source);
    }
});
