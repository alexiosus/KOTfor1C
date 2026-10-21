import { validateVanessaFormToolArguments, type VanessaFormToolDescriptor, type VanessaFormToolSchema } from './vanessaControlFormTools';
export interface VanessaFormToolUi {
    pick(title: string, choices: readonly { id: string; label: string; description?: string }[]): Promise<string | undefined>;
    input(title: string, value: string, validate: (value: string) => string | undefined): Promise<string | undefined>;
}
const omitted = '__omit';
function parseField(schema: VanessaFormToolSchema, value: string): unknown {
    if (schema.type === 'string') { return value; }
    if (schema.type === 'number' || schema.type === 'integer') { return value.trim() ? Number(value) : NaN; }
    return JSON.parse(value) as unknown;
}
/** A cancelled field cancels the operation. Run is offered only for a complete valid payload. */
export async function collectVanessaFormToolArguments(tool: VanessaFormToolDescriptor, ui: VanessaFormToolUi,
    initial: Readonly<Record<string, unknown>> = {}): Promise<Record<string, unknown> | undefined> {
    const args: Record<string, unknown> = { ...initial }; const properties = tool.inputSchema.properties ?? {};
    while (true) {
        let valid = false;
        try { validateVanessaFormToolArguments(tool, args); valid = true; } catch { /* Missing fields stay editable. */ }
        const action = await ui.pick(tool.name, [
            ...(valid ? [{ id: 'run', label: 'Run form tool' }] : []),
            ...Object.entries(properties).map(([key, schema]) => ({ id: key,
                label: `${key}${tool.inputSchema.required?.includes(key) ? ' *' : ''}`,
                description: `${schema.type}${Object.hasOwn(args, key) ? ' • set' : ''} — ${schema.description ?? ''}` }))
        ]);
        if (action === undefined) { return; }
        if (action === 'run' && valid) { return validateVanessaFormToolArguments(tool, args); }
        const schema = properties[action]; if (!schema) { return; }
        const optional = !tool.inputSchema.required?.includes(action);
        if (schema.enum || schema.type === 'boolean') {
            const values = schema.enum ?? [true, false];
            const picked = await ui.pick(action, [
                ...(optional ? [{ id: omitted, label: 'Use Vanessa default (omit)' }] : []),
                ...values.map(value => ({ id: String(value), label: String(value) }))
            ]);
            if (picked === undefined) { return; }
            if (picked === omitted && optional) { delete args[action]; continue; }
            const value = values.find(item => String(item) === picked);
            if (value === undefined) { return; } args[action] = value;
        } else {
            const validate = (value: string) => {
                try {
                    const fieldTool: VanessaFormToolDescriptor = { ...tool, inputSchema: { type: 'object', properties: { [action]: schema }, required: [action] } };
                    validateVanessaFormToolArguments(fieldTool, { [action]: parseField(schema, value) });
                    return undefined;
                } catch { return 'Enter a value matching the advertised field type.'; }
            };
            const current = args[action] ?? schema.default;
            const value = await ui.input(`${action} (${schema.type})`, current === undefined ? '' : typeof current === 'string' ? current : JSON.stringify(current), validate);
            if (value === undefined) { return; }
            if (optional && value === '' && schema.type !== 'string') { delete args[action]; continue; }
            if (validate(value)) { return; } args[action] = parseField(schema, value);
        }
    }
}
