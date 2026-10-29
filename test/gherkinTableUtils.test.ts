import assert from 'node:assert/strict';
import test from 'node:test';
import { alignGherkinTablesInText, planGherkinHeaderColumnDeletion } from '../src/gherkinTableUtils';

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

test('deleting a column row by row never restores removed cells and resumes alignment when complete', () => {
    for (const eol of ['\n', '\r\n']) {
        for (const order of [[0, 1, 2], [1, 0, 2], [2, 1, 0]]) {
            const rows = ['    | Name | Value |', '    | Alice | 1 |', '    | Bob | 2 |'];
            const reduced = ['    | Name |', '    | Alice |', '    | Bob |'];
            for (let index = 0; index < order.length - 1; index++) {
                rows[order[index]] = reduced[order[index]];
                const editing = ['And table', ...rows, ''].join(eol);
                assert.equal(alignGherkinTablesInText(editing, eol), editing,
                    'a table with unequal cell counts must remain unchanged while its column is being removed');
            }
            rows[order[2]] = reduced[order[2]];
            assert.equal(alignGherkinTablesInText(['And table', ...rows, ''].join(eol), eol),
                ['And table', '    | Name  |', '    | Alice |', '    | Bob   |', ''].join(eol));
        }
    }
});

test('an unfinished table row does not reindent or complete the rest of that table', () => {
    for (const incomplete of ['    | Name | Value', '    | Name', '    |']) {
        for (const index of [0, 1, 2]) {
            const rows = ['    | Name | Value |', '    | Alice | 1 |', '    | Bob | 2 |'];
            rows[index] = incomplete;
            const source = ['And table', ...rows, ''].join('\n');
            assert.equal(alignGherkinTablesInText(source, '\n'), source);
        }
    }
});

test('an unfinished table does not block alignment of a separate complete table', () => {
    const unfinished = 'And first table\n    | Name |\n    | Alice | 1 |\n';
    const source = unfinished + 'And another table\n    | A | B |\n    | Longer | 2 |\n';
    assert.equal(alignGherkinTablesInText(source, '\n'),
        unfinished + 'And another table\n    | A      | B |\n    | Longer | 2 |\n');
});

function deleteHeaderCell(source: string, chunk: string) {
    const offset = source.indexOf(chunk);
    assert.ok(offset >= 0, chunk);
    const edits = planGherkinHeaderColumnDeletion(source, { offset, length: chunk.length });
    let result = source;
    for (const edit of [...edits, { start: offset, end: offset + chunk.length }].sort((a, b) => b.start - a.start)) {
        result = result.slice(0, edit.start) + result.slice(edit.end);
    }
    return { result, edits };
}

test('removing a complete first, middle or last header cell deletes its column in every data row', () => {
    const header = '    | Name | Value | Flag |';
    const data = ['    | Alice | 1 | true |', '    | Bob | 22 | false |'];
    for (const eol of ['\n', '\r\n']) {
        for (const [chunk, dataChunks] of [
            ['| Name ', ['| Alice ', '| Bob ']],
            [' Name |', ['| Alice ', '| Bob ']],
            ['| Value ', ['| 1 ', '| 22 ']],
            [' Value |', ['| 1 ', '| 22 ']],
            ['Value |', ['| 1 ', '| 22 ']],
            ['Value | ', ['| 1 ', '| 22 ']],
            [' | Value', ['| 1 ', '| 22 ']],
            ['| Flag ', ['| true ', '| false ']],
            [' Flag |', ['| true ', '| false ']]
        ] as const) {
            const source = ['And table', header, ...data, 'And next step', ''].join(eol);
            const { result, edits } = deleteHeaderCell(source, chunk);
            assert.equal(edits.length, 2, chunk);
            assert.equal(result, ['And table', header.replace(chunk, ''), ...data.map((row, index) => row.replace(dataChunks[index], '')), 'And next step', ''].join(eol));
        }
    }
});

test('header column deletion preserves escaped pipes and identifies repeated or blank headers by position', () => {
    for (const header of ['    | Same | Same | Third |', '    | Same |      | Third |']) {
        const source = ['And table', header, '    | A\\|B | C | D |', '    | E | F\\|G | H |', ''].join('\n');
        const pipes = [...header.matchAll(/\|/gu)].map(match => match.index!);
        const offset = source.indexOf(header) + pipes[1];
        const edits = planGherkinHeaderColumnDeletion(source, { offset, length: pipes[2] - pipes[1] });
        assert.deepEqual(edits.map(edit => source.slice(edit.start, edit.end)), ['| C ', '| F\\|G ']);
    }
    const source = 'And table\n    | Name | A\\|B | Third |\n    | One | Two | Three |\n';
    assert.equal(deleteHeaderCell(source, ' A\\|B |').result,
        'And table\n    | Name | Third |\n    | One | Three |\n');
});

test('partial edits, cleared titles, data cells and incomplete tables never delete other values', () => {
    const source = 'And table\n    | Name | Value |\n    | Alice | 1 |\n    | Bob | 2 |\n';
    for (const chunk of ['Value', 'alue |', '|', '| Alice ', 'Name | Value', '| Name | Value |\n']) {
        assert.deepEqual(deleteHeaderCell(source, chunk).edits, [], chunk);
    }
    for (const body of [
        '| Name | Value |',
        '| Name | Value |\n    | Alice |',
        '| Name | Value |\n    | Alice | 1',
        '| Name | Value |\n    | Alice | 1\\|',
        '| Name |\n    | Alice |'
    ]) {
        const text = 'And table\n    ' + body + '\n';
        assert.deepEqual(deleteHeaderCell(text, '| Name ').edits, [], body);
    }
});

test('table-shaped text in docstrings and block comments cannot trigger column deletion', () => {
    for (const [open, close] of [['"""', '"""'], ["'''", "'''"], ['```', '```'], ['/*', '*/']]) {
        const source = `And text\n${open}\n    | Name | Value |\n    | Alice | 1 |\n${close}\n`;
        assert.deepEqual(deleteHeaderCell(source, '| Name ').edits, [], open);
    }
});

test('an escaped final pipe cannot make an unfinished row look complete to the formatter', () => {
    const source = 'And table\n    | Name | Value |\n    | Alice | 1\\|\n';
    assert.equal(alignGherkinTablesInText(source, '\n'), source);
});
