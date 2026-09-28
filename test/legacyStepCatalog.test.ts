import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseLegacyStepsHtml } from '../src/legacyStepCatalog';

test('bundled steps HTML converts all 1177 rows into step definitions', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'res', 'steps.htm'), 'utf8');
    const steps = parseLegacyStepsHtml(html);
    assert.equal(steps.length, 1177);
    assert.ok(steps.some(step => step.ru?.pattern && step.en?.pattern));
    assert.ok(steps.some(step => step.ru && !step.en));
});

test('legacy adapter preserves multiline pattern content and normalizes CRLF', () => {
    const html = `
        <table>
            <tr class="R1">
                <td>И таблица:\r\n| колонка |</td>
                <td>Описание\r\nв две строки</td>
                <td>And table:\r\n| column |</td>
                <td>Description\r\nin two lines</td>
            </tr>
        </table>`;
    const steps = parseLegacyStepsHtml(html);
    assert.equal(steps[0].ru?.pattern, 'И таблица:\n| колонка |');
    assert.equal(steps[0].en?.description, 'Description\nin two lines');
});

test('legacy adapter rejects an HTML document without valid step rows', () => {
    assert.throws(
        () => parseLegacyStepsHtml('<html><body>empty</body></html>'),
        /step rows/
    );
});
