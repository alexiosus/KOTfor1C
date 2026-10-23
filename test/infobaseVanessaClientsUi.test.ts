import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { parse } from 'node-html-parser';
test('client rows expose per-profile status/actions without bulk selection without rendering credentials or private launch keys', () => {
    const script = fs.readFileSync('media/infobaseVanessaClients.js', 'utf8');
    const start = script.indexOf('    function escapeHtml('); const end = script.indexOf('    function create(', start);
    const context = vm.createContext({}); vm.runInContext(script.slice(start, end), context);
    const html = context.renderClientRows([{ id: 'own', name: '<b>Own</b>', username: 'Tester', state: 'connected', active: true,
        clientType: 'Thin', computerName: 'localhost', port: 1538, password: 'PRIVATE', additionalParameters: 'PRIVATE-KEY' }], new Set(['own']), (_key: string, fallback: string) => fallback);
    const doc = parse(html); assert.equal(doc.querySelector('b'), null); assert.ok(doc.textContent.includes('<b>Own</b>'));
    assert.equal(doc.querySelector('input[type="checkbox"]'), null);
    assert.ok(doc.querySelector('[data-client-action="disconnect"]'));
    assert.equal(doc.querySelector('[data-client-action="add"]'), null);
    assert.ok(doc.querySelector('[data-client-action="edit"]'));
 assert.ok(doc.querySelector('[data-client-action="remove"]'));
    assert.ok(!html.includes('PRIVATE')); assert.match(html, /Connected/u);
});
