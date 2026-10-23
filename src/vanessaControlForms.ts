import { formStepContext, formStepElementState, formStepHash, formStepSection, formStepTarget, type VanessaFormStepCache, type VanessaFormStepResult } from './vanessaControlFormSteps';
import type { FormExplorerElementInfo, FormExplorerSnapshot } from './formExplorerTypes';

export interface VanessaFormIdentity { readonly client: string; readonly windowTitle: string; readonly formName: string }
export interface VanessaFormWindows { readonly client: string; readonly titles: readonly string[] }
export type VanessaFormTool = 'get_form_analysis' | 'get_form_element_data' | 'get_window_list_testclient' | 'window_management' | 'manage_form_elements';
export interface VanessaFormPorts {
    identity(): Promise<VanessaFormIdentity>;
    request(tool: VanessaFormTool, args: Readonly<Record<string, unknown>>): Promise<unknown>;
    isCurrent?(): boolean;
}
export class VanessaFormControlError extends Error {}
export class VanessaFormContextChangedError extends VanessaFormControlError {}
const unconfirmed = () => new VanessaFormControlError('The Vanessa form response was not confirmed. Refresh the form.');
const changed = () => new VanessaFormContextChangedError('The Vanessa client, window or session changed. Refresh the form.');
function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function vanessaFormReplyText(reply: unknown): string {
    const result = record(reply); const content = result?.content;
    if (result?.isError || !Array.isArray(content) || content.length !== 1) { throw unconfirmed(); }
    const block = record(content[0]);
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 1_000_000 || block.text.includes('\u0000')) { throw unconfirmed(); }
    return block.text.replace(/\r\n/gu, '\n');
}
function boolean(value: string): boolean | undefined {
    return ['да', 'yes', 'true'].includes(value.toLocaleLowerCase()) ? true : ['нет', 'no', 'false'].includes(value.toLocaleLowerCase()) ? false : undefined;
}
const stamp = (identity: VanessaFormIdentity) => JSON.stringify([identity.client, identity.windowTitle, identity.formName]);
function kind(type: string): string {
    return /таблицаформы|таблица формы|formtable/iu.test(type) ? 'table' : /кнопк|button/iu.test(type) ? 'button'
        : /групп|group|командн.*панел|commandbar/iu.test(type) ? 'group' : /поле|field/iu.test(type) ? 'field' : 'element';
}

/** .45 noncompact tree formatter is unescaped text. Reject ambiguity, never infer omitted state. */
export function parseVanessaFormTree(reply: unknown, identity: VanessaFormIdentity, generatedAt: string): FormExplorerSnapshot {
    const text = vanessaFormReplyText(reply).trim();
    const empty = '# Анализ текущей формы\n\n## Элементы формы\nНет данных.';
    const match = /^# Анализ текущей формы\n\n## Элементы формы\n```text\n([\s\S]*?)\n```$/u.exec(text);
    if (!match && text !== empty) { throw unconfirmed(); }
    const lines = match?.[1].split('\n').filter(Boolean) ?? [];
    const formNames = lines.flatMap(line => {
        const form = /^-- .* \[([^\[\]{}\n]*)\] \{Тестируемая форма\} \{Видимость:[^{}\n]+\}$/u.exec(line);
        return form ? [form[1]] : [];
    });
    // Desktop windows can contain several embedded forms with the same control names.
    // Only the branch confirmed by get_active_window_data belongs to the active form.
    const scoped = formNames.length > 1;
    if (scoped && formNames.filter(name => name === identity.formName).length !== 1) { throw unconfirmed(); }
    const roots: FormExplorerElementInfo[] = []; const stack: Array<{ path: string; children: FormExplorerElementInfo[]; wrapper: boolean; included: boolean }> = [];
    const paths = new Set<string>(); let previous = -1; let count = 0;
    for (const line of lines) {
        const row = /^(-{1,30}) (.*) \[([^\[\]{}\n]*)\] \{([^{}\n]+)\} \{Видимость:([^{}\n]+)\}$/u.exec(line);
        if (!row || ++count > 5_000) { throw unconfirmed(); }
        const depth = row[1].length - 1; const visible = boolean(row[5]);
        // At depth 30 the upstream formatter clamps indentation; hierarchy is no longer provable.
        if (depth >= 29 || depth > previous + 1 || visible === undefined || !stack[depth - 1] && depth !== 0) { throw unconfirmed(); }
        const parent = depth === 0 ? { path: 'Form', children: roots, included: true } : stack[depth - 1];
        const wrapper = ['Тестируемое окно клиентского приложения', 'Тестируемая форма'].includes(row[4]);
        if (wrapper && (depth > 1 || !parent || depth === 1 && !stack[0]?.wrapper)) { throw unconfirmed(); }
        if (wrapper) { stack[depth] = { ...parent, wrapper, included: parent.included && (!scoped || depth !== 1 || row[3] === identity.formName) }; }
        else {
            if (!row[3] || /[.\r\n]/u.test(row[3])) { throw unconfirmed(); }
            const path = `${parent.path}.${row[3]}`;
            if (parent.included) { if (paths.has(path)) { throw unconfirmed(); } paths.add(path); }
            const element: FormExplorerElementInfo = { path, name: row[3], title: row[2], type: row[4], kind: kind(row[4]), visible, children: [] };
            if (parent.included) { parent.children.push(element); }
            stack[depth] = { path, children: element.children, wrapper: false, included: parent.included };
        }
        stack.length = depth + 1; previous = depth;
    }
    return { schemaVersion: 1, generatedAt, source: { application: 'Vanessa Automation', adapter: 'MCP', origin: 'live', sessionId: stamp(identity) },
        form: { windowTitle: identity.windowTitle, title: identity.windowTitle, name: identity.formName, metadataPath: identity.formName },
        elements: roots, tables: [], attributes: [], commands: [], notes: [] };
}

export function parseVanessaFormElement(reply: unknown, expectedName: string): Partial<FormExplorerElementInfo> {
    const lines = vanessaFormReplyText(reply).trim().split('\n');
    if (lines.shift() !== '# Данные элемента формы') { throw unconfirmed(); }
    const sections = ['## Основная информация', '## Значение элемента формы', '## Состояние']; let section = -1;
    const fields = new Map<string, string>(); let multilineKey: string | undefined;
    const keys = [['Имя', 'Заголовок', 'Вид', 'Тип'], ['Значение', 'Представление'], ['Доступность', 'Видимость', 'ТолькоПросмотр', 'Пометка', 'Таблица в режиме редактирования']];
    for (const line of lines) {
        if (line.startsWith('## ')) { if (line !== sections[++section]) { throw unconfirmed(); } multilineKey = undefined; continue; }
        const field = /^- ([^:]+): (.*)$/u.exec(line);
        if (field && keys[section]?.includes(field[1])) {
            if (fields.has(field[1])) { throw unconfirmed(); }
            fields.set(field[1], field[2]); multilineKey = section === 1 ? field[1] : undefined;
        } else if (multilineKey && section === 1) { fields.set(multilineKey, fields.get(multilineKey) + '\n' + line); }
        else if (line.trim()) { throw unconfirmed(); }
    }
    if (section !== 2 || fields.get('Имя') !== expectedName) { throw unconfirmed(); }
    const result: Partial<FormExplorerElementInfo> = { name: expectedName, title: fields.get('Заголовок'), valuePreview: (fields.get('Представление') ?? fields.get('Значение'))?.replace(/\n+$/u, '') };
    for (const [key, target] of [['Доступность', 'available'], ['Видимость', 'visible'], ['ТолькоПросмотр', 'readOnly']] as const) {
        if (fields.has(key)) { const value = boolean(fields.get(key)!); if (value === undefined) { throw unconfirmed(); } result[target] = value; }
    }
    return result;
}

export class VanessaRuntimeForms {
    constructor(private readonly ports: VanessaFormPorts) {}
    /** Background polling follows form changes; in-place structure changes require an explicit full read. */
    async refresh(snapshot: FormExplorerSnapshot): Promise<FormExplorerSnapshot> {
        if (snapshot.source?.adapter === 'MCP' && snapshot.source.sessionId === stamp(await this.identity())) { return snapshot; }
        return this.read();
    }
    async read(): Promise<FormExplorerSnapshot> {
        const identity = await this.identity();
        const reply = await this.request('get_form_analysis', { format: 'elements', compact: false, only_visible: false });
        await this.checkIdentity(stamp(identity));
        return parseVanessaFormTree(reply, identity, new Date().toISOString());
    }
    async element(snapshot: FormExplorerSnapshot, path: string): Promise<FormExplorerSnapshot> {
        if (snapshot.source?.adapter !== 'MCP' || !snapshot.source.sessionId) { throw changed(); }
        await this.checkIdentity(snapshot.source.sessionId);
        const elements: FormExplorerElementInfo[] = [];
        const collect = (rows: FormExplorerElementInfo[]) => { for (const row of rows) { elements.push(row); collect(row.children); } }; collect(snapshot.elements);
        const selected = elements.find(row => row.path === path);
        if (!selected?.name || elements.filter(row => row.name === selected.name).length !== 1) {
            throw new VanessaFormControlError('This form element has no unique MCP name. Refresh the form or use the snapshot source.');
        }
        let details: Partial<FormExplorerElementInfo>;
        try { details = parseVanessaFormElement(await this.request('get_form_element_data', { element_name: selected.name }), selected.name); }
        finally { await this.checkIdentity(snapshot.source.sessionId); }
        const update = (rows: FormExplorerElementInfo[]): FormExplorerElementInfo[] => rows.map(row => ({ ...row, ...(row.path === path ? details : {}), children: update(row.children) }));
        return { ...snapshot, generatedAt: new Date().toISOString(), elements: update(snapshot.elements) };
    }
    /** Focus is explicit user-authorized behavior; never substitute a click or value edit. */
    async steps(snapshot: FormExplorerSnapshot, path: string, cache: VanessaFormStepCache, language: string): Promise<VanessaFormStepResult> {
        const target = formStepTarget(snapshot, path);
        if (!target) { throw new VanessaFormControlError('Native steps require a unique visible element that MCP can activate. Groups and decorations cannot be activated.'); }
        if (snapshot.source?.adapter !== 'MCP' || !snapshot.source.sessionId) { throw changed(); }
        await this.checkIdentity(snapshot.source.sessionId);
        const name = target.element.name!;
        await this.request('manage_form_elements', target.table
            ? { action: 'activate_column', table_name: target.table.name, value: name }
            : { action: 'activate_header_element', element_name: name });
        await this.checkIdentity(snapshot.source.sessionId);
        const inspected = await this.element(snapshot, path);
        const selected = formStepTarget(inspected, path);
        if (!selected) { throw changed(); }
        const element = formStepElementState(selected.element);
        cache.enter(formStepContext(inspected, language));
        const previous = cache.get(path);
        let text: string; let state: string | undefined; let cached = false;
        if (previous && previous.element === element) {
            // .45 has no cheap revision API. Check the actual reported form state;
            // a missing state is not evidence that cached values are unchanged.
            state = formStepSection(vanessaFormReplyText(await this.request('get_form_analysis', { format: 'gherkin' })), '## Gherkin-состояние формы');
            if (state && formStepHash(state) === previous.state) { text = previous.text; cached = true; }
        }
        if (!cached) {
            const reply = vanessaFormReplyText(await this.request('get_form_analysis', { format: 'full', compact: false, max_depth: 1 }));
            const generated = formStepSection(reply, '## Часто используемые шаги для текущего элемента');
            if (generated === undefined) { throw new VanessaFormControlError('Vanessa did not return native steps for the activated element.'); }
            text = generated; state = formStepSection(reply, '## Gherkin-состояние формы');
        }
        await this.checkIdentity(snapshot.source.sessionId);
        const confirmed = await this.element(inspected, path);
        const finalElement = formStepTarget(confirmed, path)?.element;
        if (!finalElement || formStepElementState(finalElement) !== element) { throw changed(); }
        this.current();
        if (state && !cached) { cache.set(path, { text: text!, state: formStepHash(state), element }); }
        const active = (rows: FormExplorerElementInfo[]): FormExplorerElementInfo[] => rows.map(row => ({ ...row, active: row.path === path, children: active(row.children) }));
        return { text: text!, cached, snapshot: { ...confirmed, form: { ...confirmed.form, activeElementPath: path }, elements: active(confirmed.elements) } };
    }

    async windows(): Promise<VanessaFormWindows> {
        const identity = await this.identity();
        const text = vanessaFormReplyText(await this.request('get_window_list_testclient', {})).split('\n## ')[0].trim();
        const count = /^В клиенте тестирования найдено (\d+) окон:(?:\n|$)/u.exec(text)?.[1];
        const titles = [...text.matchAll(/^   -([^\r\n]+)$/gmu)].map(match => match[1]);
        if (count === undefined || Number(count) !== titles.length || titles.length > 100 || new Set(titles).size !== titles.length ||
            identity.client !== (await this.identity()).client) { throw unconfirmed(); }
        return Object.freeze({ client: identity.client, titles: Object.freeze(titles) });
    }
    async activateWindow(expected: VanessaFormWindows, title: string): Promise<FormExplorerSnapshot> {
        if (!title || /[\r\n\u0000*]/u.test(title) || !expected.titles.includes(title)) { throw unconfirmed(); }
        const current = await this.windows();
        if (current.client !== expected.client || !current.titles.includes(title)) { throw changed(); }
        await this.request('window_management', { action: 'activate', window_title: title });
        const selected = await this.identity();
        if (selected.client !== expected.client || selected.windowTitle !== title) { throw changed(); }
        const snapshot = await this.read(); await this.checkIdentity(stamp(selected)); return snapshot;
    }
    private current(): void { if (this.ports.isCurrent && !this.ports.isCurrent()) { throw changed(); } }
    private async identity(): Promise<VanessaFormIdentity> {
        this.current(); let result: VanessaFormIdentity;
        try { result = await this.ports.identity(); }
        catch (error) { throw error instanceof VanessaFormControlError ? new VanessaFormContextChangedError(error.message) : changed(); }
        this.current(); return result;
    }
    private async checkIdentity(expected: string): Promise<void> { if (stamp(await this.identity()) !== expected) { throw changed(); } }
    private async request(tool: VanessaFormTool, args: Readonly<Record<string, unknown>>) {
        this.current(); let reply: unknown;
        try { reply = await this.ports.request(tool, args); } catch { throw unconfirmed(); }
        this.current(); vanessaFormReplyText(reply); return reply;
    }
}
