import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

/** Minimal DOM boundary; the unmodified webview script owns handlers, requests and status updates. */
class Element {
    children: Element[] = [];
    dataset: Record<string, string> = {};
    attributes = new Map<string, string>();
    classes = new Set<string>();
    textContent = ''; value = ''; disabled = false; hidden = false; scrollTop = 0; inert = false;
    onclick?: () => unknown;
    onchange?: () => unknown;
    classList = { toggle: (key: string, active: boolean) => { if (active) { this.classes.add(key); } else { this.classes.delete(key); } } };
    constructor(readonly id = '') {}
    set innerHTML(html: string) {
        this.children = [...html.matchAll(/<\w+\b([^>]*)>/gu)].map(([, attributes]) => {
            const element = new Element(attributes.match(/\bid="([^"]+)"/u)?.[1]);
            for (const [, key, value] of attributes.matchAll(/data-([\w-]+)="([^"]*)"/gu)) { element.dataset[key] = value; }
            return element;
        });
    }
    insertAdjacentHTML(_position: string, html: string) { const wrapper = new Element(); wrapper.innerHTML = html; this.children.push(...wrapper.children); }
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    removeAttribute(key: string) { this.attributes.delete(key); }
    querySelectorAll(selector: string): Element[] {
        const key = selector.match(/^\[data-([\w-]+)\]$/u)?.[1];
        return this.children.flatMap(child => [...(key && Object.hasOwn(child.dataset, key) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(): null { return null; }
}

async function fixture(setup: boolean | 'editor' | 'settings' | 'inspection' = false, editorDraft: Record<string, unknown> = {}, savedState: Record<string, unknown> = {}) {
    const roots = ['content', 'notice', 'brand', 'navigation', 'section-navigation', 'section-select', 'navigation-actions'].map(id => new Element(id));
    const find = (id: string, elements = roots): Element | undefined => elements.find(node => node.id === id) ?? elements.map(node => find(id, node.children)).find(Boolean);
    let receive!: (event: { data: unknown }) => void;
    const messages: Array<{ id: string; type: string; folder?: string; action?: string }> = [];
    const workbench = new Element();
    const document = { getElementById: find, addEventListener() {}, querySelector: () => workbench };
    vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'media/kotWorkspace.js'), 'utf8'), {
        document, window: { addEventListener: (_name: string, callback: typeof receive) => { receive = callback; } },
        acquireVsCodeApi: () => ({ getState: () => savedState, setState() {}, postMessage: (message: typeof messages[number]) => messages.push(message) })
    });
    const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
    const model = { strings: {}, settings: [], sections: [{ id: 'editor', title: 'Editor' }, { id: 'agent', title: 'Testing agent' }] };
    if (setup === 'editor' || setup === 'settings' || setup === 'inspection') {
        const local = { key: 'kotTestToolkit.steps.localCatalogPath', section: 'editor', label: 'Local Vanessa step catalog',
            type: 'string', default: '', description: 'Offline steps', pathKind: 'json' };
        const mode = { key: 'kotTestToolkit.steps.catalogMode', section: 'editor', label: 'Step catalog mode',
            type: 'string', default: 'online', enum: ['online', 'offline'], description: 'Online or offline steps' };
        const compiler = { key: 'kotTestToolkit.paths.buildScenarioBddEpf', section: 'editor', label: 'SPPR compiler',
            type: 'string', default: 'build/BuildScenarioBDD.epf', description: 'Compiler for SPPR', pathKind: 'epf' };
        receive({ data: { type: 'boot', view: setup === 'settings' ? 'settings' : 'setup', folder: 'file:///project',
            folders: [{ id: 'file:///project', path: 'C:/project' }], platform: 'win32', primaryFolder: 'file:///project', profiles: { profiles: [] },
            catalogSettings: {}, model: { ...model, settings: [local, mode, compiler] },
            progress: { step: setup === 'inspection' ? 1 : 2, draft: { route: 'new', mode: 'vanessa', libraries: '', profileId: 'new', ...editorDraft } } } });
        if (setup === 'settings') { await respond(messages.find(message => message.type === 'settings')!.id, undefined, [{ key: local.key, value: '' }, { key: mode.key, value: 'online' }, { key: compiler.key, value: compiler.default, token: 'compiler-token' }]); }
        return { click: () => find('catalog-mode')!.onchange!(), respond, messages, notice: find('notice')!, content: find('content')!, workbench, find,
            send: async (data: unknown) => { receive({ data }); await flush(); } };
    }
    if (setup) {
        receive({ data: { type: 'boot', view: 'setup', folder: 'file:///project', folders: [{ id: 'file:///project' }], model,
            progress: { step: 5, draft: { route: 'sppr', mode: 'sppr', run: true } } } });
        receive({ data: { type: 'response', id: messages.find(message => message.type === 'reviewSetup')!.id,
            data: { id: 'review', files: [], settings: [], migrate: [], profile: '', run: true } } }); await flush();
        return { click: () => find('next')!.onclick!(), respond, messages, notice: find('notice')!, content: find('content')!, workbench, find,
            send: async (data: unknown) => { receive({ data }); await flush(); } };
    }
    receive({ data: { type: 'boot', view: 'settings', folder: '', folders: [], model } });
    const settings = messages.find(message => message.type === 'settings')!;
    receive({ data: { type: 'response', id: settings.id, data: [] } }); await flush();
    roots.find(node => node.id === 'navigation')!.querySelectorAll('[data-view]').find(button => button.dataset.view === 'help')!.onclick!();
    const click = () => find('show-tool')!.onclick!();
    async function respond(id: string, error?: string, data?: unknown) { receive({ data: { type: 'response', id, error, data } }); await flush(); }
    return { click, respond, messages, notice: find('notice')!, content: find('content')!, workbench, find,
        send: async (data: unknown) => { receive({ data }); await flush(); } };
}

test('AI connection button invokes the registered setup action without asking for JSON', async () => {
    const h = await fixture('settings');
    void h.find('connect-ai')!.onclick!();
    const request = h.messages.find(message => message.type === 'action');
    assert.equal((request as unknown as { action: string }).action, 'agent');
    await h.respond(request!.id);
});

test('restoring the removed AI settings section opens the testing agent section', async () => {
    const h = await fixture('settings', {}, { section: 'ai' });
    assert.equal(h.find('section-select')!.value, 'agent');
    assert.ok(h.find('connect-ai'));
});

test('editor setup offers an online/offline switch and persists the choice without launching a generator dialog', async () => {
    const h = await fixture('editor', { run: true, vanessa: 'local/vanessa-automation.epf' });
    assert.equal(h.find('catalog-mode')!.value, 'online');
    assert.ok(h.find('catalog-vanessa')); assert.ok(h.find('download-vanessa'));
    h.find('catalog-mode')!.value = 'offline'; h.click();
    assert.equal(h.find('catalog-mode')!.value, 'offline');
    assert.ok(h.find('catalog-vanessa'));
    assert.ok(!h.messages.some(message => message.type === 'action' || message.type === 'retryExecution'));
    const progress = h.messages.filter(message => message.type === 'progress').at(-1) as any;
    assert.equal(progress.data.draft.catalogMode, 'offline');
    h.find('next')!.onclick!();
    assert.ok(h.find('platform')); assert.ok(h.find('edit-vanessa'));
    assert.equal(h.find('vanessa'), undefined); assert.equal(h.find('catalog-vanessa'), undefined); assert.equal(h.find('download-vanessa'), undefined);
    h.find('edit-vanessa')!.onclick!();
    assert.ok(h.find('catalog-vanessa')); assert.ok(h.find('download-vanessa'));
    assert.equal(h.content.querySelectorAll('[data-path]').filter(control => control.dataset.path === 'setup.vanessa').length, 1);
    const returned = h.messages.filter(message => message.type === 'progress').at(-1) as any;
    assert.equal(returned.data.draft.vanessa, 'local/vanessa-automation.epf');
});

test('SPPR compiler export fills the wizard draft after completion without applying configuration', async () => {
    const h = await fixture('editor', { run: true, mode: 'sppr', compiler: 'build/BuildScenarioBDD.epf' });
    h.find('next')!.onclick!();
    const operation = h.find('export-compiler')!.onclick!();
    const request = h.messages.find(message => message.type === 'exportSpprCompiler')!;
    assert.ok(request); assert.equal((request as any).value, 'build/BuildScenarioBDD.epf');
    assert.equal(h.find('export-compiler')!.disabled, true);
    await h.respond(request.id, undefined, 'build/ExportedCompiler.epf'); await operation;
    assert.equal(h.find('compiler')!.value, 'build/ExportedCompiler.epf');
    assert.equal((h.messages.filter(message => message.type === 'progress').at(-1) as any).data.draft.compiler, 'build/ExportedCompiler.epf');
    assert.ok(!h.messages.some(message => ['applySetup', 'applySettings', 'retryExecution'].includes(message.type)));
});

test('compiler export does not overwrite a path edited while export is running', async () => {
    const h = await fixture('editor', { run: true, mode: 'sppr', compiler: 'build/original.epf' });
    h.find('next')!.onclick!(); const operation = h.find('export-compiler')!.onclick!();
    const request = h.messages.find(message => message.type === 'exportSpprCompiler')!;
    h.find('compiler')!.value = 'build/manual.epf'; h.find('compiler')!.onchange!();
    await h.respond(request.id, undefined, 'build/exported.epf'); await operation;
    assert.equal(h.find('compiler')!.value, 'build/manual.epf');
    assert.equal((h.messages.filter(message => message.type === 'progress').at(-1) as any).data.draft.compiler, 'build/manual.epf');
});

test('settings compiler export stages its path for Apply without writing configuration immediately', async () => {
    const h = await fixture('settings');
    const button = h.content.querySelectorAll('[data-export-compiler]')[0]; assert.ok(button);
    const operation = button.onclick!(); const request = h.messages.find(message => message.type === 'exportSpprCompiler')!;
    assert.ok(request); await h.respond(request.id, undefined, 'build/settings-compiler.epf'); await operation;
    const changes = (h.messages.filter(message => message.type === 'draft').at(-1) as any).data;
    assert.equal(changes[0].key, 'kotTestToolkit.paths.buildScenarioBddEpf'); assert.equal(changes[0].value, 'build/settings-compiler.epf');
    assert.equal(changes[0].token, 'compiler-token'); assert.ok(!h.messages.some(message => message.type === 'applySettings'));
});

test('environment Check replaces Continue until all checks pass, and editing a checked path resets it', async () => {
    const h = await fixture('editor', { run: true, mode: 'sppr', platform: '1cv8c.exe', compiler: 'build/compiler.epf' });
    h.find('next')!.onclick!();
    assert.equal(h.find('next')!.textContent, 'Check'); assert.equal(h.find('skip-check')!.hidden, false);
    assert.equal(h.find('check-runtime'), undefined); assert.ok(h.find('export-compiler'));
    const first = h.find('next')!.onclick!(); h.find('next')!.onclick!();
    assert.equal(h.messages.filter(message => message.type === 'checkRuntime').length, 1);
    assert.equal(h.find('next')!.disabled, true); assert.equal(h.find('skip-check')!.disabled, true);
    await h.respond(h.messages.findLast(message => message.type === 'checkRuntime')!.id, undefined,
        { checks: [{ label: 'Compiler', ok: false, message: 'Missing file' }], platforms: [] }); await first;
    assert.equal(h.find('next')!.textContent, 'Check'); assert.equal(h.find('next')!.disabled, false);
    assert.equal(h.find('skip-check')!.hidden, false); assert.ok(h.find('compiler'));
    const retry = h.find('next')!.onclick!();
    await h.respond(h.messages.findLast(message => message.type === 'checkRuntime')!.id, undefined,
        { checks: [{ label: 'Compiler', ok: true, message: 'Ready' }], platforms: [] }); await retry;
    assert.equal(h.find('next')!.textContent, 'Continue'); assert.equal(h.find('skip-check')!.hidden, true);
    h.find('compiler')!.value = 'build/changed.epf'; h.find('compiler')!.onchange!();
    assert.equal(h.find('next')!.textContent, 'Check'); assert.equal(h.find('skip-check')!.hidden, false);
    assert.equal(h.find('runtime-checks')!.children.length, 0);
});

test('a failed check request and a stale successful result cannot enable Continue', async () => {
    const h = await fixture('editor', { run: true, mode: 'sppr', compiler: 'build/compiler.epf' }); h.find('next')!.onclick!();
    const failed = h.find('next')!.onclick!();
    await h.respond(h.messages.findLast(message => message.type === 'checkRuntime')!.id, 'Cannot read file'); await failed;
    assert.equal(h.find('next')!.textContent, 'Check'); assert.equal(h.find('next')!.disabled, false);
    const stale = h.find('next')!.onclick!();
    h.find('compiler')!.value = 'build/new.epf'; h.find('compiler')!.onchange!();
    await h.respond(h.messages.findLast(message => message.type === 'checkRuntime')!.id, undefined,
        { checks: [{ label: 'Compiler', ok: true, message: 'Old path exists' }], platforms: [] }); await stale;
    assert.equal(h.find('next')!.textContent, 'Check'); assert.equal(h.find('compiler')!.value, 'build/new.epf');
});

test('runtime skip retains selected paths, reviews the skipped check and does not automatically connect after applying', async () => {
    const h = await fixture('editor', { run: true, mode: 'sppr', compiler: 'build/compiler.epf', vanessa: 'tools/va.epf' });
    h.find('next')!.onclick!(); h.find('skip-check')!.onclick!();
    const draft = (h.messages.filter(message => message.type === 'progress').at(-1) as any).data.draft;
    assert.equal(draft.skipRuntimeCheck, true); assert.equal(draft.run, true);
    assert.equal(draft.compiler, 'build/compiler.epf'); assert.equal(draft.vanessa, 'tools/va.epf');
    assert.ok(!h.messages.some(message => message.type === 'checkRuntime'));
    h.find('next')!.onclick!(); const review = h.messages.findLast(message => message.type === 'reviewSetup')!;
    await h.respond(review.id, undefined, { id: 'review', files: [], settings: [], migrate: [], profile: '', run: true, skipRuntimeCheck: true });
    assert.equal((review as any).data.skipRuntimeCheck, true);
    h.find('next')!.onclick!();
    await h.respond(h.messages.find(message => message.type === 'applySetup')!.id, undefined, { complete: true });
    assert.ok(h.find('retry-execution'));
    assert.ok(!h.messages.some(message => message.type === 'retryExecution'));
});

test('project inspection uses the same Check to Continue flow and an explicit skip', async () => {
    const h = await fixture('inspection'); assert.equal(h.find('next')!.textContent, 'Check');
    const result = { sppr: [], processes: [], features: [], libraries: [], launchJson: [], metadata: [],
        roots: { vanessa: { sources: '', libraries: '' } }, truncated: false };
    const checking = h.find('next')!.onclick!();
    assert.equal(h.find('cancel-scan')!.hidden, false);
    await h.respond(h.messages.find(message => message.type === 'scan')!.id, undefined, result); await checking;
    assert.equal(h.find('next')!.textContent, 'Continue'); assert.equal(h.find('skip-check')!.hidden, true);
    assert.equal(h.find('cancel-scan')!.hidden, true);
    h.find('mode')!.value = 'sppr'; h.find('mode')!.onchange!();
    assert.equal(h.find('next')!.textContent, 'Check');
    const scans = h.messages.filter(message => message.type === 'scan').length;
    h.find('skip-check')!.onclick!(); assert.ok(h.find('sources'));
    assert.equal(h.messages.filter(message => message.type === 'scan').length, scans);
});

test('incomplete and cancelled inspections leave Check and Skip available', async () => {
    const h = await fixture('inspection');
    const incomplete = h.find('next')!.onclick!();
    await h.respond(h.messages.findLast(message => message.type === 'scan')!.id, undefined, { sppr: [], processes: [], features: [], libraries: [], launchJson: [], metadata: [],
        roots: { vanessa: { sources: '', libraries: '' } }, truncated: true }); await incomplete;
    assert.equal(h.find('next')!.textContent, 'Check'); assert.equal(h.find('skip-check')!.hidden, false);
    const cancelled = h.find('next')!.onclick!(); h.find('cancel-scan')!.onclick!();
    assert.equal(h.messages.at(-1)!.type, 'cancel');
    await h.respond(h.messages.findLast(message => message.type === 'scan')!.id, 'Project inspection cancelled'); await cancelled;
    assert.equal(h.find('next')!.textContent, 'Check'); assert.equal(h.find('next')!.disabled, false);
    assert.equal(h.find('skip-check')!.disabled, false);
});

test('editor setup keeps the MXL opener and executable in its draft and opens the fixed official download page separately', async () => {
    const h = await fixture('editor'); assert.equal(h.find('mxl-mode')!.value, 'fileWorkshop');
    h.find('file-workshop')!.value = 'C:\\1C files\\1cv8fv.exe'; h.find('file-workshop')!.onchange!();
    const opening = h.find('download-file-workshop')!.onclick!(); assert.equal(h.messages.at(-1)!.type, 'openFileWorkshopDownload');
    await h.respond(h.messages.at(-1)!.id); await opening;
    h.find('mxl-mode')!.value = 'platform'; h.find('mxl-mode')!.onchange!();
    let draft = (h.messages.filter(message => message.type === 'progress').at(-1) as any).data.draft;
    assert.equal(draft.mxlOpeningMode, 'platform'); assert.equal(draft.fileWorkshop, 'C:\\1C files\\1cv8fv.exe');
    assert.equal(h.find('file-workshop'), undefined);
    h.find('mxl-mode')!.value = 'fileWorkshop'; h.find('mxl-mode')!.onchange!();
    draft = (h.messages.filter(message => message.type === 'progress').at(-1) as any).data.draft;
    assert.equal(draft.fileWorkshop, 'C:\\1C files\\1cv8fv.exe');
    assert.ok(!h.messages.some(message => message.type === 'applySettings' || message.type === 'applySetup' || message.type === 'retryExecution'));
});

test('sidebar footer opens extension resources without changing the settings draft', async () => {
    const h = await fixture('settings');
    for (const [id, type] of [['native-settings', 'openNative'], ['repository-link', 'openRepository'], ['changelog-link', 'openChangelog']]) {
        const operation = h.find(id)!.onclick!();
        assert.equal(h.messages.at(-1)?.type, type);
        await h.respond(h.messages.at(-1)!.id); await operation;
    }
    assert.ok(!h.messages.some(message => message.type === 'applySettings' || message.type === 'applySetup'));
});

test('offline setup downloads a selected release, displays its progress and keeps the path as a setup draft', async () => {
    const h = await fixture('editor'); h.find('catalog-mode')!.value = 'offline'; h.click();
    const pending = h.find('download-vanessa')!.onclick!();
    const request = h.messages.find(message => message.type === 'downloadVanessa')!;
    assert.ok(request); assert.equal(h.find('download-vanessa')!.disabled, true);
    assert.equal(h.find('next')!.disabled, true);
    await h.send({ type: 'vanessaDownloadProgress', id: request.id, folder: 'file:///project', label: 'Downloading', completed: 50, total: 100 });
    assert.equal(h.find('vanessa-download-label')!.textContent, 'Downloading 50%');
    await h.send({ type: 'vanessaDownloadProgress', id: request.id, folder: 'file:///other', label: 'Wrong project' });
    assert.equal(h.find('vanessa-download-label')!.textContent, 'Downloading 50%');
    const downloaded = 'tools/vanessa/1.2.043.47/vanessa-automation.epf';
    await h.respond(request.id, undefined, { path: downloaded, version: '1.2.043.47' }); await pending;
    const draft = (h.messages.filter(message => message.type === 'progress').at(-1) as any).data.draft;
    assert.equal(draft.vanessa, downloaded); assert.equal(h.find('download-vanessa')!.disabled, false);
    assert.equal(h.find('vanessa-download-progress')!.hidden, true);
    assert.equal(h.find('next')!.disabled, false);
    assert.ok(!h.messages.some(message => message.type === 'applySetup' || message.type === 'applySettings'));
});

test('a download never replaces a path edited while choosing a release, and cancellation is recoverable', async () => {
    const h = await fixture('editor'); h.find('catalog-mode')!.value = 'offline'; h.click();
    const first = h.find('download-vanessa')!.onclick!();
    const request = h.messages.find(message => message.type === 'downloadVanessa')!;
    h.find('catalog-vanessa')!.value = 'custom/vanessa.epf'; h.find('catalog-vanessa')!.onchange!();
    await h.respond(request.id, undefined, { path: 'tools/vanessa/version/vanessa-automation.epf', version: 'version' }); await first;
    assert.equal(h.find('catalog-vanessa')!.value, 'custom/vanessa.epf');
    const second = h.find('download-vanessa')!.onclick!(); const requestId = h.messages.at(-1)!.id;
    h.find('cancel-vanessa-download')!.onclick!();
    assert.equal(h.messages.at(-1)!.type, 'cancelVanessaDownload');
    await h.respond(requestId); await second;
    assert.equal(h.find('download-vanessa')!.disabled, false); assert.equal(h.find('catalog-vanessa')!.value, 'custom/vanessa.epf');
});

test('Features suggestions follow the chosen distribution, ignore stale lookups and append without replacing project libraries', async () => {
    const h = await fixture('editor', { catalogMode: 'offline', vanessa: 'tools/old/vanessa.epf', libraries: 'libraries/custom|tools/old/Features' });
    const old = h.messages.findLast(message => message.type === 'suggestVanessaLibrary')!;
    h.find('catalog-vanessa')!.value = 'tools/new/vanessa.epf'; h.find('catalog-vanessa')!.onchange!();
    const current = h.messages.findLast(message => message.type === 'suggestVanessaLibrary')!;
    await h.respond(old.id, undefined, 'tools/old/Features');
    assert.equal(h.find('vanessa-library-suggestion')!.hidden, true);
    await h.respond(current.id, undefined, 'tools/new/features');
    assert.equal(h.find('vanessa-library-suggestion')!.hidden, false);
    assert.equal(h.find('vanessa-library-path')!.textContent, 'tools/new/features');
    h.find('add-vanessa-library')!.onclick!();
    const draft = (h.messages.filter(message => message.type === 'progress').at(-1) as any).data.draft;
    assert.equal(draft.libraries, 'libraries/custom|tools/old/Features|tools/new/features');
    await h.respond(h.messages.findLast(message => message.type === 'suggestVanessaLibrary')!.id, undefined, 'tools/new/features');
    assert.equal(h.find('vanessa-library-suggestion')!.hidden, true);
    assert.ok(!h.messages.some(message => message.type === 'applySetup' || message.type === 'applySettings'));
});

test('Features already included as an absolute Windows path are not suggested again; missing libraries stay optional', async () => {
    const h = await fixture('editor', { vanessa: 'tools/vanessa/vanessa.epf', libraries: 'C:\\PROJECT\\tools\\vanessa\\.\\FEATURES\\' });
    await h.respond(h.messages.findLast(message => message.type === 'suggestVanessaLibrary')!.id, undefined, 'tools/vanessa/features');
    assert.equal(h.find('vanessa-library-suggestion')!.hidden, true);
    h.find('catalog-mode')!.value = 'offline'; h.click();
    await h.respond(h.messages.findLast(message => message.type === 'suggestVanessaLibrary')!.id);
    assert.equal(h.find('vanessa-library-suggestion')!.hidden, true);
    assert.equal(h.find('next')!.disabled, false);
});

for (const view of ['editor', 'settings'] as const) {
    test(`${view} displays catalog export progress, completion and errors only for the selected folder`, async () => {
        const h = await fixture(view);
        assert.equal(h.find('catalog-progress')!.hidden, true);
        const send = (folder: string, progress: unknown, mode = 'offline') => h.send({ type: 'catalogProgress', folder, catalog: { mode, progress } });
        await send('file:///project', { phase: 'exporting', completed: 30, total: 100 });
        assert.equal(h.find('catalog-progress')!.hidden, false);
        assert.equal(h.find('catalog-progress')!.attributes.get('aria-busy'), 'true');
        assert.equal(h.find('catalog-progress-bar')!.value, 30);
        assert.equal(h.find('catalog-progress-label')!.textContent, 'Reading step categories: 30/100');
        await send('file:///other-project', { phase: 'error', error: 'Wrong project' });
        assert.equal(h.find('catalog-progress-label')!.textContent, 'Reading step categories: 30/100');
        await send('file:///project', { phase: 'ready', stepCount: 1208 });
        assert.equal(h.find('catalog-progress-label')!.textContent, 'Step catalog ready: 1208 steps.');
        assert.equal(h.find('catalog-progress')!.attributes.get('aria-busy'), 'false');
        assert.equal(h.find('catalog-progress-bar')!.hidden, true);
        await send('file:///project', { phase: 'error', error: 'Export failed' });
        assert.match(h.find('catalog-progress-label')!.textContent, /Export failed/u);
        assert.equal(h.find('catalog-progress')!.classes.has('field-error'), true);
        await send('file:///project', undefined, 'online');
        assert.equal(h.find('catalog-progress')!.hidden, true);
    });
}

test('Show in VS Code clears its progress after the tool opens', async () => {
    const h = await fixture(); const operation = h.click();
    assert.equal(h.notice.textContent, 'Opening tool…'); assert.equal(h.content.attributes.get('aria-busy'), 'true');
    await h.respond(h.messages.at(-1)!.id); await operation;
    assert.equal(h.notice.textContent, ''); assert.equal(h.content.attributes.has('aria-busy'), false);
});

test('a failed tool opening retains the error after busy state ends', async () => {
    const h = await fixture(); const operation = h.click();
    await h.respond(h.messages.at(-1)!.id, 'Tool is unavailable'); await operation;
    assert.equal(h.notice.textContent, 'Tool is unavailable'); assert.equal(h.notice.classes.has('notice-error'), true);
    assert.equal(h.content.attributes.has('aria-busy'), false);
});

test('completion of an older tool request leaves the newer request in progress', async () => {
    const h = await fixture(); const first = h.click(); const firstId = h.messages.at(-1)!.id;
    const second = h.click(); const secondId = h.messages.at(-1)!.id;
    await h.respond(firstId); await first;
    assert.equal(h.notice.textContent, 'Opening tool…'); assert.equal(h.content.attributes.get('aria-busy'), 'true');
    await h.respond(secondId); await second;
    assert.equal(h.notice.textContent, ''); assert.equal(h.content.attributes.has('aria-busy'), false);
});

test('applying setup leaves the page scrollable and restores controls after failure', async () => {
    const h = await fixture(true); h.click();
    assert.equal(h.workbench.inert, false);
    assert.equal(h.find('next')!.disabled, true);
    assert.equal(h.find('back')!.disabled, true);
    await h.respond(h.messages.find(message => message.type === 'applySetup')!.id, 'Migration failed');
    assert.equal(h.find('next')!.disabled, false);
    assert.equal(h.find('back')!.disabled, false);
    assert.equal(h.notice.textContent, 'Migration failed');
});

test('setup progress shows file counts only for the current application', async () => {
    const h = await fixture(true); h.click();
    const id = h.messages.find(message => message.type === 'applySetup')!.id;
    await h.send({ type: 'setupProgress', id: 'older', label: 'Wrong operation', completed: 50, total: 100 });
    assert.notEqual(h.notice.textContent, 'Wrong operation');
    await h.send({ type: 'setupProgress', id, label: 'Migrating project metadata…', completed: 42, total: 100 });
    assert.match(h.notice.textContent, /Migrating project metadata.*42.*100/u);
    await h.respond(id, 'Migration failed');
    await h.send({ type: 'setupProgress', id, label: 'Late progress', completed: 80, total: 100 });
    assert.equal(h.notice.textContent, 'Migration failed');
});

test('finished setup opens the ready page while Vanessa preparation is still pending', async () => {
    const h = await fixture(true); h.click();
    h.click();
    assert.equal(h.messages.filter(message => message.type === 'applySetup').length, 1);
    await h.respond(h.messages.find(message => message.type === 'applySetup')!.id, undefined, { complete: true, executionReady: false });
    assert.ok(h.find('example'));
    assert.equal(h.find('example')!.disabled, false);
    assert.equal(h.workbench.inert, false);
    assert.equal(h.find('execution-state')!.attributes.get('aria-busy'), 'true');
    assert.equal(h.messages.filter(message => message.type === 'retryExecution').length, 1);
    await h.respond(h.messages.find(message => message.type === 'retryExecution')!.id, 'Vanessa failed');
    assert.equal(h.find('execution-state')!.attributes.get('aria-busy'), 'false');
    assert.ok(h.find('retry-execution'));
    assert.equal(h.notice.textContent, 'Vanessa failed');
});
