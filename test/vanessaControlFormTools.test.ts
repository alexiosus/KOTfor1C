import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

let api: Record<string, (...args: any[]) => any>;
try { api = require('../src/vanessaControlFormTools'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') { throw error; }
    api = {};
}
const catalog = (tools: unknown[]) => {
    assert.equal(typeof api.getVanessaFormTools, 'function');
    return api.getVanessaFormTools(tools);
};
const validate = (tool: unknown, args: unknown) => {
    assert.equal(typeof api.validateVanessaFormToolArguments, 'function');
    return api.validateVanessaFormToolArguments(tool, args);
};
const schema = { type: 'object', properties: { action: { type: 'string', enum: ['read', 'write'] }, count: { type: 'integer', minimum: 1, maximum: 3 },
    full: { type: 'boolean' } }, required: ['action'], additionalProperties: false };
const tool = (inputSchema: unknown = schema, name = 'manage_form_elements') => ({ name, description: 'Owned form action', inputSchema });

test('advertised .45 form schemas remain usable while run/control tools stay outside the form catalog', () => {
    const actual = JSON.parse(fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/tools.live.json', 'utf8')).tools;
    const tools = catalog(actual);
    assert.deepEqual(tools.map((item: any) => item.name).sort(), ['get_active_window_data', 'get_form_analysis', 'get_form_element_data', 'get_window_list_testclient', 'user_actions_recording', 'window_management']);
    assert.deepEqual(validate(tools.find((item: any) => item.name === 'get_form_element_data'), { element_name: 'Owned' }), { element_name: 'Owned' });
});

test('every advertised form action, table data and command tool is available without conflating database reads with UI rows', () => {
    const names = ['get_form_analysis', 'get_form_element_data', 'find_form_elements', 'manage_form_elements', 'execute_form_actions',
        'user_actions_recording', 'save_table_document_to_file', 'get_active_window_data', 'get_window_list_testclient', 'window_management',
        'manage_command_interface', 'get_object_attributes', 'get_table_data'];
    assert.deepEqual(catalog(names.map(name => tool({ type: 'object', properties: {} }, name))).map((item: any) => item.name), names);
    assert.deepEqual(catalog([tool(schema, 'run_scenario'), tool(schema, 'execute_step_from_text'), tool(schema, 'get_current_element_checks')]), []);
});

test('duplicate names and unsupported or malformed schemas are omitted instead of guessing a callable contract', () => {
    assert.deepEqual(catalog([tool(), tool()]), []);
    for (const bad of [null, { type: 'string' }, { type: 'object', required: ['missing'] }, { ...schema, required: ['action', 'action'] },
        { ...schema, anyOf: [] }, { ...schema, properties: { action: { type: 'string', pattern: 'x' } } },
        { ...schema, properties: { action: { type: 'integer', minimum: 4, maximum: 1 } } },
        { ...schema, properties: { action: { type: 'array' } } }, { ...schema, properties: { action: { type: 'string', enum: [1] } } },
        { ...schema, additionalProperties: { type: 'string' } }]) {
        assert.deepEqual(catalog([tool(bad)]), []);
    }
});

test('required arguments, enums, booleans and numeric bounds reject bad input without echoing private values', () => {
    const [own] = catalog([tool()]);
    assert.deepEqual(validate(own, { action: 'read', count: 2, full: false }), { action: 'read', count: 2, full: false });
    for (const bad of [null, [], {}, { action: 'private invalid value' }, { action: 'read', count: 0 }, { action: 'read', count: 4 },
        { action: 'read', count: 1.5 }, { action: 'read', count: NaN }, { action: 'read', count: Infinity }, { action: 'read', full: 'false' },
        { action: 'read', secret: 'private invalid value' }]) {
        assert.throws(() => validate(own, bad), error => !String(error).includes('private invalid value'));
    }
});

test('nested objects and arrays retain typed fields and enforce required fields, length limits and item bounds', () => {
    const inputSchema = { type: 'object', properties: { actions: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object',
        properties: { label: { type: 'string', minLength: 2, maxLength: 4 }, amount: { type: 'number', minimum: 0, maximum: 1 } }, required: ['label'], additionalProperties: false } } }, required: ['actions'] };
    const [own] = catalog([tool(inputSchema, 'execute_form_actions')]);
    assert.deepEqual(own.inputSchema, inputSchema);
    const args = { actions: [{ label: 'Own', amount: 0.5 }] };
    const result = validate(own, args);
    assert.deepEqual(result, args); assert.notEqual(result, args); assert.notEqual(result.actions, args.actions);
    for (const bad of [[], [{ label: 'x' }], [{ label: 'large' }], [{ amount: 1 }], [{ label: 'Own', unexpected: true }],
        [{ label: 'Own', amount: -1 }], [{ label: 'Own' }, { label: 'Own' }, { label: 'Own' }]]) {
        assert.throws(() => validate(own, { actions: bad }));
    }
});

test('catalogs detach their schema and cannot be changed by later advertised metadata mutation', () => {
    const advertised = tool(JSON.parse(JSON.stringify(schema)));
    const [own] = catalog([advertised]);
    advertised.inputSchema.properties.action.enum.push('unexpected');
    assert.throws(() => validate(own, { action: 'unexpected' }));
    assert.ok(Object.isFrozen(own)); assert.ok(Object.isFrozen(own.inputSchema.properties.action.enum));
});

test('schema and argument depth, size and prototype-like keys are bounded before a tool can run', () => {
    let nested: unknown = { type: 'string' };
    for (let i = 0; i < 20; i++) { nested = { type: 'object', properties: { nested } }; }
    assert.deepEqual(catalog([tool(nested)]), []);
    const [own] = catalog([tool({ type: 'object', properties: { text: { type: 'string' }, rows: { type: 'array', items: { type: 'string' } } } })]);
    assert.throws(() => validate(own, { text: 'x'.repeat(1_000_001) }));
    assert.throws(() => validate(own, { rows: Array(10_001).fill('x') }));
    assert.throws(() => validate(own, JSON.parse('{"__proto__":{"polluted":true}}')));
    assert.deepEqual(catalog([tool(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'))]), []);
    assert.throws(() => validate({ ...own, name: 'run_scenario' }, {}));
});
