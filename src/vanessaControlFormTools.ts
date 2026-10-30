/** Form-related tools verified in Vanessa .45. get_table_data reads the database, not UI table rows. */
const formToolNames = new Set([
    'get_form_analysis', 'get_form_element_data', 'find_form_elements', 'manage_form_elements', 'execute_form_actions',
    'user_actions_recording', 'save_table_document_to_file', 'get_active_window_data', 'get_window_list_testclient',
    'window_management', 'manage_command_interface', 'get_object_attributes', 'get_table_data'
]);

export interface VanessaFormToolSchema {
    readonly type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
    readonly description?: string;
    readonly title?: string;
    readonly default?: unknown;
    readonly properties?: Readonly<Record<string, VanessaFormToolSchema>>;
    readonly required?: readonly string[];
    readonly additionalProperties?: false;
    readonly items?: VanessaFormToolSchema;
    readonly enum?: readonly (string | number | boolean)[];
    readonly minimum?: number;
    readonly maximum?: number;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly minItems?: number;
    readonly maxItems?: number;
}

export interface VanessaFormToolDescriptor {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: VanessaFormToolSchema;
}

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const schemaKeys = new Set(['type', 'description', 'title', 'default', 'properties', 'required', 'additionalProperties', 'items', 'enum',
    'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
const limits = { depth: 8, schemaNodes: 2_048, properties: 128, argumentNodes: 20_000, arrayItems: 10_000, textLength: 1_000_000 };
const invalid = () => new Error('The advertised form tool schema or arguments are invalid or unsupported.');

function object(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined;
}

function primitiveMatches(type: VanessaFormToolSchema['type'], value: unknown): value is string | number | boolean {
    return type === 'string' ? typeof value === 'string' : type === 'boolean' ? typeof value === 'boolean'
        : (type === 'number' || type === 'integer') && typeof value === 'number' && Number.isFinite(value)
            && (type !== 'integer' || Number.isInteger(value));
}

function readSchema(value: unknown, depth = 0, budget = { nodes: 0 }): VanessaFormToolSchema {
    const raw = object(value);
    if (!raw || depth > limits.depth || ++budget.nodes > limits.schemaNodes || Object.keys(raw).some(key => !schemaKeys.has(key))) { throw invalid(); }
    const type = raw.type as VanessaFormToolSchema['type'];
    if (!['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(type)) { throw invalid(); }
    const result: Record<string, unknown> = { type };
    for (const key of ['description', 'title'] as const) {
        if (!Object.hasOwn(raw, key)) { continue; }
        if (typeof raw[key] !== 'string' || raw[key].length > 20_000) { throw invalid(); }
        result[key] = raw[key];
    }
    for (const [keys, applicable] of [
        [['minimum', 'maximum'], type === 'number' || type === 'integer'],
        [['minLength', 'maxLength'], type === 'string'],
        [['minItems', 'maxItems'], type === 'array']
    ] as const) {
        for (const key of keys) {
            if (!Object.hasOwn(raw, key)) { continue; }
            const number = raw[key];
            if (!applicable || typeof number !== 'number' || !Number.isFinite(number)
                || (key !== 'minimum' && key !== 'maximum' && (!Number.isSafeInteger(number) || number < 0))) { throw invalid(); }
            result[key] = number;
        }
        const [lower, upper] = keys.map(key => result[key]);
        if (typeof lower === 'number' && typeof upper === 'number' && lower > upper) { throw invalid(); }
    }
    if (Object.hasOwn(raw, 'enum')) {
        if (!Array.isArray(raw.enum) || raw.enum.length < 1 || raw.enum.length > limits.properties
            || !raw.enum.every(item => primitiveMatches(type, item) && (typeof item !== 'string' || item.length <= limits.textLength))
            || new Set(raw.enum).size !== raw.enum.length) { throw invalid(); }
        result.enum = Object.freeze([...raw.enum]);
    }
    if (type === 'object') {
        const properties = raw.properties === undefined ? {} : object(raw.properties);
        if (!properties || Object.keys(properties).length > limits.properties || Object.keys(properties).some(key => unsafeKeys.has(key) || key.length > 200)) { throw invalid(); }
        if (Object.hasOwn(raw, 'properties')) {
            result.properties = Object.freeze(Object.fromEntries(Object.entries(properties).map(([key, field]) => [key, readSchema(field, depth + 1, budget)])));
        }
        if (Object.hasOwn(raw, 'required')) {
            if (!Array.isArray(raw.required) || !raw.required.every(key => typeof key === 'string' && Object.hasOwn(properties, key))
                || new Set(raw.required).size !== raw.required.length) { throw invalid(); }
            result.required = Object.freeze([...raw.required]);
        }
        if (Object.hasOwn(raw, 'additionalProperties')) {
            if (raw.additionalProperties !== false) { throw invalid(); }
            result.additionalProperties = false;
        }
    } else if (['properties', 'required', 'additionalProperties'].some(key => Object.hasOwn(raw, key))) { throw invalid(); }
    if (type === 'array') { result.items = readSchema(raw.items, depth + 1, budget); }
    else if (Object.hasOwn(raw, 'items')) { throw invalid(); }
    if (Object.hasOwn(raw, 'default')) {
        result.default = validateValue(result as unknown as VanessaFormToolSchema, raw.default, 0, { nodes: 0, textLength: 0 });
    }
    return Object.freeze(result) as unknown as VanessaFormToolSchema;
}

/** Preserve the supported advertised schema for typed UI fields; ambiguous tools are never offered. */
export function getVanessaFormTools(tools: readonly unknown[]): readonly VanessaFormToolDescriptor[] {
    const names = new Map<string, number>();
    for (const tool of tools) {
        const name = object(tool)?.name;
        if (typeof name === 'string' && formToolNames.has(name)) { names.set(name, (names.get(name) ?? 0) + 1); }
    }
    const result: VanessaFormToolDescriptor[] = [];
    for (const value of tools) {
        const tool = object(value);
        if (!tool || typeof tool.name !== 'string' || !formToolNames.has(tool.name) || names.get(tool.name) !== 1) { continue; }
        try {
            const inputSchema = readSchema(tool.inputSchema);
            if (inputSchema.type !== 'object' || (tool.description !== undefined && (typeof tool.description !== 'string' || tool.description.length > 20_000))) { continue; }
            result.push(Object.freeze({ name: tool.name, description: typeof tool.description === 'string' ? tool.description : '', inputSchema }));
        } catch { /* Unsupported advertised schema remains unavailable. */ }
    }
    return Object.freeze(result);
}

function validateValue(schema: VanessaFormToolSchema, value: unknown, depth: number, budget: { nodes: number; textLength: number }): unknown {
    if (depth > limits.depth || ++budget.nodes > limits.argumentNodes) { throw invalid(); }
    if (schema.type === 'object') {
        const args = object(value);
        if (!args || Object.keys(args).length > limits.properties || (schema.required ?? []).some(key => !Object.hasOwn(args, key))) { throw invalid(); }
        const properties = schema.properties ?? {};
        if (Object.keys(args).some(key => unsafeKeys.has(key) || !Object.hasOwn(properties, key))) { throw invalid(); }
        return Object.fromEntries(Object.entries(args).map(([key, field]) => [key, validateValue(properties[key], field, depth + 1, budget)]));
    }
    if (schema.type === 'array') {
        if (!Array.isArray(value) || value.length > limits.arrayItems || value.length < (schema.minItems ?? 0)
            || value.length > (schema.maxItems ?? limits.arrayItems) || !schema.items) { throw invalid(); }
        return value.map(item => validateValue(schema.items!, item, depth + 1, budget));
    }
    if (!primitiveMatches(schema.type, value) || (schema.enum && !schema.enum.includes(value))) { throw invalid(); }
    if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) { throw invalid(); }
    if (typeof value === 'string') {
        budget.textLength += value.length;
        if (budget.textLength > limits.textLength || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? limits.textLength)) { throw invalid(); }
    }
    return value;
}

/** Arguments are validated before dispatch; errors never include field values or returned business data. */
export function validateVanessaFormToolArguments(tool: VanessaFormToolDescriptor, args: unknown): Record<string, unknown> {
    if (!formToolNames.has(tool.name)) { throw invalid(); }
    const schema = readSchema(tool.inputSchema);
    if (schema.type !== 'object') { throw invalid(); }
    return validateValue(schema, args, 0, { nodes: 0, textLength: 0 }) as Record<string, unknown>;
}
