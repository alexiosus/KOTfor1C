import assert from 'node:assert/strict';
import test from 'node:test';
import { collectVanessaFormToolArguments } from '../src/vanessaControlFormToolWorkflow';
import type { VanessaFormToolDescriptor } from '../src/vanessaControlFormTools';
const tool: VanessaFormToolDescriptor = { name: 'get_form_analysis', description: '', inputSchema: { type: 'object', properties: {
    format: { type: 'string', enum: ['elements', 'full'] }, compact: { type: 'boolean' }, max_depth: { type: 'integer', minimum: 1 } }, required: ['format'] } };
test('form tool fields preserve booleans and numbers and omit untouched optional parameters', async () => {
    const actions = ['format', 'full', 'compact', 'false', 'max_depth', 'run'];
    const args = await collectVanessaFormToolArguments(tool, { pick: async (_title, choices) => {
        const id = actions.shift(); assert.ok(choices.some(choice => choice.id === id)); return id;
    }, input: async () => '2' });
    assert.deepEqual(args, { format: 'full', compact: false, max_depth: 2 });
    assert.equal(actions.length, 0);
});
test('cancelled parameter editing never supplies a partial command', async () => {
    let n = 0;
    assert.equal(await collectVanessaFormToolArguments(tool, { pick: async () => n++ === 0 ? 'format' : undefined, input: async () => undefined }), undefined);
});
test('a required missing field prevents Run and optional values can be removed', async () => {
    const actions = ['format', 'elements', 'compact', 'true', 'compact', '__omit', 'run'];
    const args = await collectVanessaFormToolArguments(tool, { pick: async (_title, choices) => {
        if (actions.length === 7) { assert.ok(!choices.some(choice => choice.id === 'run')); }
        const id = actions.shift(); assert.ok(choices.some(choice => choice.id === id)); return id;
    }, input: async () => undefined });
    assert.deepEqual(args, { format: 'elements' });
});
