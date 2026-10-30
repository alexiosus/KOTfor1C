import { createHash } from 'node:crypto';
import type { FormExplorerElementInfo, FormExplorerSnapshot } from './formExplorerTypes';
export interface VanessaFormStepResult { readonly snapshot: FormExplorerSnapshot; readonly text: string; readonly cached: boolean }
export interface VanessaFormStepEntry { readonly text: string; readonly state: string; readonly element: string }
export const formStepHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function formStepContext(snapshot: FormExplorerSnapshot, language: string): string {
    const shape = (rows: readonly FormExplorerElementInfo[]): unknown => rows.map(row => [row.path, row.name, row.kind, row.type, shape(row.children)]);
    return formStepHash([snapshot.source?.sessionId, snapshot.form.name, snapshot.form.windowTitle ?? snapshot.form.title, language, shape(snapshot.elements)]);
}
export function formStepElementState(element: FormExplorerElementInfo): string {
    return formStepHash([element.name, element.title, element.type, element.valuePreview, element.visible, element.available, element.readOnly]);
}
/** Only one form/session/language is retained. Values remain in bounded local memory, never disk. */
export class VanessaFormStepCache {
    private context: string | undefined;
    private readonly entries = new Map<string, VanessaFormStepEntry>();
    get size(): number { return this.entries.size; }
    enter(context: string): void { if (context !== this.context) { this.clear(); this.context = context; } }
    get(path: string): VanessaFormStepEntry | undefined { return this.entries.get(path); }
    /** Display a known result while a fresh server-side state check runs; never treats it as verified. */
    preview(snapshot: FormExplorerSnapshot, path: string, language: string): string | undefined {
        if (this.context !== formStepContext(snapshot, language)) { return; }
        const target = formStepTarget(snapshot, path); const entry = this.entries.get(path);
        return target && entry?.element === formStepElementState(target.element) ? entry.text : undefined;
    }
    set(path: string, entry: VanessaFormStepEntry): void {
        if (entry.text.length > 200_000) { return; }
        this.entries.delete(path); this.entries.set(path, Object.freeze(entry));
        while (this.entries.size > 64) { this.entries.delete(this.entries.keys().next().value!); }
    }
    clear(): void { this.entries.clear(); this.context = undefined; }
}
/** A missing/ambiguous fenced state cannot establish cache validity. */
export function formStepSection(text: string, heading: string): string | undefined {
    const prefix = heading + '\n'; const start = text.indexOf(prefix);
    if (start < 0 || text.indexOf(prefix, start + prefix.length) >= 0) { return; }
    const body = text.slice(start + prefix.length).split('\n## ')[0].trim();
    // .45 appends window messages after the fence without a new Markdown section.
    // Read the fenced payload only; the footer is not part of the generated steps.
    return /^```gherkin\n([\s\S]*?)\n```(?:\n|$)/u.exec(body)?.[1].trim();
}
export function formStepTarget(snapshot: FormExplorerSnapshot, path: string): { element: FormExplorerElementInfo; table?: FormExplorerElementInfo } | undefined {
    const all: FormExplorerElementInfo[] = [];
    let target: { element: FormExplorerElementInfo; ancestors: FormExplorerElementInfo[] } | undefined;
    const visit = (rows: readonly FormExplorerElementInfo[], ancestors: FormExplorerElementInfo[]) => {
        for (const element of rows) {
            all.push(element); if (element.path === path) { target = { element, ancestors }; }
            visit(element.children, [...ancestors, element]);
        }
    };
    visit(snapshot.elements, []);
    if (!target) { return; }
    const { element, ancestors } = target;
    if (!element.name || all.filter(row => row.name === element.name).length !== 1 ||
        [element, ...ancestors].some(row => row.visible === false || row.available === false || row.enabled === false) ||
        /group|групп|decoration|декорац/iu.test(element.kind ?? element.type ?? '')) { return; }
    return { element, table: [...ancestors].reverse().find(row => row.kind === 'table') };
}
