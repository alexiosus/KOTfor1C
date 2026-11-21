import { AsyncLocalStorage } from 'node:async_hooks';

export interface KotAnswer { text?: string; choices?: string[]; paths?: string[]; cancel?: boolean }
export interface KotQuestion {
    kind: 'input' | 'pick' | 'open' | 'save' | 'message'; title?: string; message?: string; value?: string; password?: boolean;
    multiple?: boolean; modal?: boolean; options?: Array<{ id: string; label: string; description?: string; detail?: string; picked?: boolean }>;
    files?: boolean; folders?: boolean; filters?: unknown;
}
export interface KotInteraction {
    ask(question: KotQuestion, validate?: (answer: KotAnswer) => Promise<void>): Promise<KotAnswer>;
    notify(level: string, message: string): void;
    progress(value: unknown): void;
    token: unknown;
    resolvePath(path: string, create: boolean): Promise<unknown>;
}
const interactions = new AsyncLocalStorage<KotInteraction>();
export const withKotInteraction = <T>(interaction: KotInteraction, work: () => Promise<T>): Promise<T> => interactions.run(interaction, work);
export async function assertKotPath(file: string, create = false): Promise<void> { await interactions.getStore()?.resolvePath(file, create); }
export const hasKotInteraction = (): boolean => !!interactions.getStore();
export const kotCancellationRequested = (): boolean => (interactions.getStore()?.token as { isCancellationRequested?: boolean } | undefined)?.isCancellationRequested === true;
const label = (item: unknown): string => typeof item === 'string' ? item : String((item as { label?: string; title?: string })?.label ?? (item as { title?: string })?.title ?? '');

/** Native UI remains the default; an API action routes only its own asynchronous prompt chain. */
export function kotWindow<T extends object>(native: T): T {
    return new Proxy(native, { get(target, key) {
        const method = Reflect.get(target, key);
        if (typeof method !== 'function') { return method; }
        if (!['showInputBox', 'showQuickPick', 'showOpenDialog', 'showSaveDialog', 'showWarningMessage', 'showInformationMessage', 'showErrorMessage', 'withProgress'].includes(String(key))) { return method.bind(target); }
        return (...args: unknown[]) => {
            const interaction = interactions.getStore();
            if (!interaction) { return method.apply(target, args); }
            const result = route(interaction, String(key), args);
            void result.catch(() => undefined); // Native notifications are often intentionally fire-and-forget.
            return result;
        };
    } });
}
async function route(host: KotInteraction, method: string, args: unknown[]): Promise<unknown> {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    if (method === 'withProgress') {
        host.progress({ title: options.title, cancellable: options.cancellable === true });
        return (args[1] as (progress: { report(value: unknown): void }, token: unknown) => Promise<unknown>)({ report: value => host.progress(value) }, host.token);
    }
    if (method === 'showInputBox') {
        const question: KotQuestion = { kind: 'input', title: options.title as string, message: (options.prompt ?? options.placeHolder) as string,
            password: options.password === true, value: options.password ? undefined : options.value as string };
        const answer = await host.ask(question, async answer => {
            if (typeof answer.text !== 'string') { throw new Error('Answer this input with text.'); }
            if (typeof options.validateInput === 'function') {
                const validation = await options.validateInput(answer.text);
                if (validation && (typeof validation === 'string' || validation.severity === 3)) { throw new Error(typeof validation === 'string' ? validation : validation.message); }
            }
        });
        return answer.cancel ? undefined : answer.text;
    }
    if (method === 'showOpenDialog' || method === 'showSaveDialog') {
        const save = method === 'showSaveDialog';
        const answer = await host.ask({ kind: save ? 'save' : 'open', title: options.title as string,
            value: (options.defaultUri as { fsPath?: string })?.fsPath, multiple: options.canSelectMany === true,
            files: options.canSelectFiles !== false, folders: options.canSelectFolders === true, filters: options.filters }, async answer => {
            if (!answer.paths?.length || (save || !options.canSelectMany) && answer.paths.length !== 1) { throw new Error('Supply the requested file/folder paths.'); }
            for (const file of answer.paths) { await host.resolvePath(file, save || options.canSelectFolders === true); }
        });
        if (answer.cancel) { return undefined; }
        const uris = await Promise.all(answer.paths!.map(file => host.resolvePath(file, save || options.canSelectFolders === true)));
        return save ? uris[0] : uris;
    }
    let items: unknown[]; let question: KotQuestion;
    if (method === 'showQuickPick') {
        items = (await args[0] as unknown[]).filter(item => !(item && typeof item === 'object' && 'kind' in item && item.kind === -1));
        const settings = args[1] as Record<string, unknown> | undefined;
        question = { kind: 'pick', title: settings?.title as string, message: settings?.placeHolder as string, multiple: settings?.canPickMany === true };
    } else {
        const message = String(args[0]); const level = method === 'showErrorMessage' ? 'error' : method === 'showWarningMessage' ? 'warning' : 'info';
        host.notify(level, message);
        items = args.slice(1).filter(item => typeof item === 'string' || item && typeof item === 'object' && 'title' in item);
        if (!items.length) { return undefined; }
        const details = args[1] && typeof args[1] === 'object' ? args[1] as { detail?: unknown; modal?: boolean } : undefined;
        question = { kind: 'message', message: message + (typeof details?.detail === 'string' ? '\n' + details.detail : ''), modal: details?.modal === true };
    }
    question.options = items.map((item, index) => ({ id: String(index), label: label(item),
        ...(item && typeof item === 'object' ? { description: (item as { description?: string }).description,
            detail: (item as { detail?: string }).detail, picked: (item as { picked?: boolean }).picked } : {}) }));
    const answer = await host.ask(question, async answer => {
        if (!answer.choices || !question.multiple && answer.choices.length !== 1 || new Set(answer.choices).size !== answer.choices.length
            || answer.choices.some(id => !question.options!.some(item => item.id === id))) { throw new Error('Select IDs from this question options.'); }
    });
    if (answer.cancel) { return undefined; }
    const selected = answer.choices!.map(id => items[Number(id)]);
    return question.multiple ? selected : selected[0];
}
