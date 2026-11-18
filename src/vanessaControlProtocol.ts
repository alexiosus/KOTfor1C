export type VanessaControlCapability = 'state' | 'editor' | 'editorContent' | 'openFeature' | 'loadFeature' | 'selectStep' | 'runFromLine' | 'runFeature' | 'runAll' | 'runCurrent' | 'oneStep' | 'stop' | 'results' | 'breakpoints'
    | 'clientProfilesRead' | 'clientProfilesWrite' | 'clientConnect' | 'clientDisconnect' | 'clientClose'
    | 'variablesRead' | 'variablesWrite' | 'formTree' | 'formWindow' | 'formElement' | 'formWindows' | 'formActivateWindow' | 'recording' | 'formChecks' | 'formSuggestions'
    | 'environment' | 'runtimeSyntax' | 'runtimeSearch' | 'managerLog' | 'clientLog' | 'screenshotWindows' | 'screenshot'
    | 'stateJson' | 'resultsJson' | 'elementSteps' | 'activeFormElement' | 'recordingResult' | 'clientProfilePort' | 'settingsRead' | 'settingsWrite' | 'mxlOpen';
export interface VanessaControlCapabilityStatus { readonly supported: boolean; readonly reason?: 'missingTool' | 'incompatibleSchema' }
export type VanessaControlCapabilities = Readonly<Record<VanessaControlCapability, VanessaControlCapabilityStatus>>;
export type VanessaControlReply =
    | { readonly kind: 'state'; readonly state: 'running' | 'idle'; readonly recording?: boolean; readonly featurePath?: string; readonly lineNumber?: number; readonly stepStatus?: VanessaStepStatus }
    | { readonly kind: 'stepResult'; readonly status: 'passed' }
    | { readonly kind: 'runResult'; readonly status: 'passed'; readonly scenarioCount: number }
    | { readonly kind: 'failureResult'; readonly featurePath: string; readonly lineNumber: number }
    | { readonly kind: 'runtimeResult'; readonly status: 'passed' | 'failed' | 'pending'; readonly message?: string }
    | { readonly kind: 'editor'; readonly featurePath: string; readonly lineNumber: number; readonly dirty: boolean; readonly content?: string }
    | { readonly kind: 'breakpoints'; readonly lines: readonly number[] }
    | { readonly kind: 'breakpointsUnavailable' }
    | { readonly kind: 'toolError' }
    | { readonly kind: 'unknown' };

export type VanessaStepStatus = 'running' | 'passed' | 'failed' | 'stopped' | 'pending';

export class VanessaEditorSourceMismatchError extends Error {
    constructor() { super('The feature in Vanessa differs from the saved source. Reload it in Vanessa, then retry.'); }
}

export function sameVanessaFeaturePath(left: string, right: string): boolean {
    const normalize = (value: string) => /^[a-z]:[\\/]|^\\\\/iu.test(value) ? value.replace(/\\/gu, '/').toLocaleLowerCase() : value;
    return normalize(left) === normalize(right);
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** VA .47 JSON is opt-in; unsupported or incomplete replies never establish success. */
export function readVanessaStructuredReply(value: unknown): Record<string, unknown> | undefined {
    const reply = object(value);
    if (reply?.isError || !Array.isArray(reply?.content) || reply.content.length !== 1) { return; }
    const block = object(reply.content[0]);
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 1_000_000) { return; }
    try {
        const data = object(JSON.parse(block.text));
        return data?.schemaVersion === '1.1' && typeof data.ok === 'boolean' ? data : undefined;
    } catch { return; }
}

function parseVanessaStructuredReply(tool: string, text: string): VanessaControlReply {
    const data = readVanessaStructuredReply({ content: [{ type: 'text', text }] });
    if (!data || data.ok !== true || typeof data.isRunning !== 'boolean') { return { kind: 'unknown' }; }
    const statuses: Record<string, VanessaStepStatus> = { running: 'running', success: 'passed', failed: 'failed', broken: 'stopped', pending: 'pending' };
    if (tool === 'get_vanessa_automation_state') {
        const feature = object(data.currentFeature); const step = object(data.currentStep);
        const line = step?.lineNumber;
        return { kind: 'state', state: data.isRunning ? 'running' : 'idle',
            ...(typeof feature?.fullPath === 'string' && /\.feature$/iu.test(feature.fullPath) ? { featurePath: feature.fullPath } : {}),
            ...(typeof line === 'number' && Number.isSafeInteger(line) && line > 0 ? { lineNumber: line } : {}),
            ...(typeof step?.status === 'string' && statuses[step.status] ? { stepStatus: statuses[step.status] } : {}) };
    }
    if (data.isRunning || data.isComplete !== true || !Array.isArray(data.steps) || !data.steps.length) { return { kind: 'unknown' }; }
    const rows = data.steps.map(object);
    if (rows.some(row => !row || typeof row.status !== 'string' || !['success', 'failed', 'broken', 'pending', 'skipped'].includes(row.status))) { return { kind: 'unknown' }; }
    const failed = object(data.failedStep);
    if (['failed', 'broken'].includes(String(data.status)) && typeof data.featurePath === 'string' && /\.feature$/iu.test(data.featurePath) &&
        typeof failed?.lineNumber === 'number' && Number.isSafeInteger(failed.lineNumber) && failed.lineNumber > 0) {
        return { kind: 'failureResult', featurePath: data.featurePath, lineNumber: failed.lineNumber };
    }
    if (data.status === 'success' && rows.every(row => row!.status === 'success')) { return { kind: 'runtimeResult', status: 'passed' }; }
    const message = object(data.error)?.message;
    if (['failed', 'broken', 'pending'].includes(String(data.status))) {
        return { kind: 'runtimeResult', status: data.status === 'pending' ? 'pending' : 'failed', ...(typeof message === 'string' && message ? { message } : {}) };
    }
    return { kind: 'unknown' };
}

/** Validate the actual tools/list contract, including new mandatory arguments we cannot supply. */
export function assessVanessaControlCapabilities(tools: readonly unknown[]): VanessaControlCapabilities {
    const contracts: Record<VanessaControlCapability, { tool: string; fields: Record<string, string>; literals?: Record<string, readonly unknown[]> }> = {
        state: { tool: 'get_vanessa_automation_state', fields: {} },
        stateJson: { tool: 'get_vanessa_automation_state', fields: { format: 'string' }, literals: { format: ['json'] } },
        resultsJson: { tool: 'get_test_results', fields: { format: 'string' }, literals: { format: ['json'] } },
        elementSteps: { tool: 'get_form_element_steps', fields: { element_name: 'string', mode: 'string', table_name: 'string', table_scope: 'string' }, literals: { mode: ['suggestions', 'checks'], table_scope: ['current', 'all'] } },
        activeFormElement: { tool: 'get_active_form_element', fields: {} },
        recordingResult: { tool: 'user_actions_recording', fields: { action: 'string', capture_id: 'number' }, literals: { action: ['status', 'get_result'] } },
        clientProfilePort: { tool: 'manage_test_client_profiles', fields: { action: 'string', name: 'string', port: 'integer' }, literals: { action: ['add', 'edit', 'get_list'] } },
        settingsRead: { tool: 'get_va_settings', fields: { action: 'string', key: 'string', query: 'string', limit: 'integer', format: 'string' }, literals: { action: ['list', 'get'], format: ['json'] } },
        settingsWrite: { tool: 'manage_va_settings', fields: { action: 'string', key: 'string', value: 'string', parameters_json: 'string', base_path: 'string', dry_run: 'boolean', expected_revision: 'integer', expected_current_value: 'string', format: 'string' }, literals: { action: ['set', 'apply'], format: ['json'] } },
        editor: { tool: 'get_editor_state', fields: { includeContent: 'boolean' }, literals: { includeContent: [false] } },
        editorContent: { tool: 'get_editor_state', fields: { includeContent: 'boolean' }, literals: { includeContent: [true] } },
        openFeature: { tool: 'open_feature_file', fields: { filePath: 'string' } },
        loadFeature: { tool: 'load_features', fields: { path: 'string' } },
        selectStep: { tool: 'select_step', fields: { lineNumber: 'integer' } },
        runFromLine: { tool: 'run_scenario', fields: { mode: 'string', filePath: 'string', lineNumber: 'integer' }, literals: { mode: ['reloadAndRunFromLine'] } },
        runFeature: { tool: 'run_scenario', fields: { mode: 'string', filePath: 'string' }, literals: { mode: ['reloadAndRun'] } },
        runAll: { tool: 'run_scenario', fields: { mode: 'string' }, literals: { mode: ['all'] } },
        runCurrent: { tool: 'run_scenario', fields: { mode: 'string' }, literals: { mode: ['fromCurrentStep'] } },
        oneStep: { tool: 'execute_feature_step', fields: { filePath: 'string', lineNumber: 'integer' } },
        mxlOpen: { tool: 'execute_step_from_text', fields: { stepText: 'string' } },
        stop: { tool: 'stop_scenario', fields: {} },
        results: { tool: 'get_test_results', fields: { scenarioId: 'string' } },
        breakpoints: { tool: 'manage_breakpoints', fields: { action: 'string', line: 'number' }, literals: { action: ['list', 'toggle'] } },
        clientProfilesRead: { tool: 'manage_test_client_profiles', fields: { action: 'string' }, literals: { action: ['get_list'] } },
        clientProfilesWrite: { tool: 'manage_test_client_profiles', fields: { action: 'string', name: 'string', synonym: 'string', infobase_path: 'string',
            additional_parameters: 'string', client_type: 'string', computer_name: 'string' }, literals: { action: ['add', 'edit'] } },
        clientConnect: { tool: 'manage_test_client', fields: { action: 'string', profileName: 'string' }, literals: { action: ['connect'] } },
        clientDisconnect: { tool: 'manage_test_client', fields: { action: 'string' }, literals: { action: ['disconnect'] } },
        clientClose: { tool: 'close_test_client', fields: { profileName: 'string' } },
        formTree: { tool: 'get_form_analysis', fields: { format: 'string', compact: 'boolean', only_visible: 'boolean' }, literals: { format: ['elements'], compact: [false], only_visible: [false] } },
        formWindow: { tool: 'get_active_window_data', fields: { type: 'string' }, literals: { type: ['window_caption', 'form_name'] } },
        formElement: { tool: 'get_form_element_data', fields: { element_name: 'string' } },
        formWindows: { tool: 'get_window_list_testclient', fields: {} },
        formActivateWindow: { tool: 'window_management', fields: { action: 'string', window_title: 'string' }, literals: { action: ['activate'] } },
        recording: { tool: 'user_actions_recording', fields: { action: 'string' }, literals: { action: ['start', 'stop'] } },
        formChecks: { tool: 'get_form_analysis', fields: { format: 'string' }, literals: { format: ['gherkin'] } },
        formSuggestions: { tool: 'get_form_analysis', fields: { format: 'string', compact: 'boolean', max_depth: 'number' }, literals: { format: ['full'], compact: [false] } },
        environment: { tool: 'get_environment_data', fields: {} },
        screenshotWindows: { tool: 'get_window_list_os', fields: {} },
        screenshot: { tool: 'get_window_screenshot_os', fields: { window_title: 'string', color_mode: 'string', file_name: 'string' }, literals: { color_mode: ['color'] } },
        runtimeSyntax: { tool: 'check_syntax', fields: { filePath: 'string' } },
        runtimeSearch: { tool: 'search_for_steps_by_keywords', fields: { search_name: 'string', limit: 'number' } },
        managerLog: { tool: 'get_event_log_manager', fields: { limit: 'number', scan_limit: 'number', columns: 'string', display_order: 'string' }, literals: { display_order: ['desc'] } },
        clientLog: { tool: 'get_event_log_test_client', fields: { limit: 'number', scan_limit: 'number', columns: 'string', display_order: 'string' }, literals: { display_order: ['desc'] } },
        variablesRead: { tool: 'manage_variables', fields: { action: 'string' }, literals: { action: ['get'] } },
        variablesWrite: { tool: 'manage_variables', fields: { action: 'string', name: 'string', value: 'string', is_global: 'boolean' }, literals: { action: ['set', 'delete'] } }
    };
    return Object.freeze(Object.fromEntries(Object.entries(contracts).map(([capability, contract]) => {
        const matches = tools.map(object).filter(tool => tool?.name === contract.tool);
        if (matches.length === 0) { return [capability, Object.freeze({ supported: false, reason: 'missingTool' })]; }
        const schema = matches.length === 1 ? object(matches[0]?.inputSchema) : undefined;
        const properties = object(schema?.properties) ?? {};
        const required = schema?.required ?? [];
        const unsupported = (value: Record<string, unknown>) => ['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'].some(key => Object.hasOwn(value, key));
        const compatible = schema?.type === 'object' && !unsupported(schema) && !Object.hasOwn(schema, 'const') && !Object.hasOwn(schema, 'enum') && Array.isArray(required)
            && required.every(name => typeof name === 'string' && Object.hasOwn(contract.fields, name))
            && Object.entries(contract.fields).every(([name, expected]) => {
                const field = object(properties[name]);
                if (!field || unsupported(field) || !(field.type === expected || expected === 'number' && field.type === 'integer')) { return false; }
                const literals = contract.literals?.[name];
                if (Object.hasOwn(field, 'const') && (!literals || !literals.every(value => value === field.const))) { return false; }
                if (Object.hasOwn(field, 'enum') && (!Array.isArray(field.enum) || !literals || !literals.every(value => (field.enum as unknown[]).includes(value)))) { return false; }
                return true;
            });
        return [capability, Object.freeze(compatible ? { supported: true } : { supported: false, reason: 'incompatibleSchema' })];
    })) as unknown as VanessaControlCapabilities);
}

/** URLs are safe to persist; authentication belongs in SecretStorage, not in the address. */
export function normalizeVanessaControlEndpoint(value: string, allowRemote = false): string {
    let url: URL;
    try { url = new URL(value.trim()); } catch { throw new Error('Invalid Vanessa MCP endpoint.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Use an HTTP(S) MCP endpoint without credentials, query, or fragment.');
    }
    if (!allowRemote && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw new Error('A remote Vanessa MCP endpoint must be explicitly selected.');
    }
    if (url.pathname === '/') { url.pathname = '/mcp'; }
    return url.toString();
}

/** Only verified formatter output establishes state; run/stop prose is never evidence of pass/pause. */
export function parseVanessaControlReply(tool: string, value: unknown): VanessaControlReply {
    const result = object(value);
    if (result?.isError === true) { return { kind: 'toolError' }; }
    if (!Array.isArray(result?.content) || !result.content.length ||
        !result.content.every(item => object(item)?.type === 'text' && typeof object(item)?.text === 'string')) {
        return { kind: 'unknown' };
    }
    const text = result.content.map(item => object(item)!.text as string).join('\n').replace(/\r\n/gu, '\n').trim();
    if (text.startsWith('{') && ['get_vanessa_automation_state', 'get_test_results'].includes(tool)) {
        return parseVanessaStructuredReply(tool, text);
    }
    if (tool === 'execute_feature_step' && text === 'Шаг в строке фича файла успешно выполнен') {
        return { kind: 'stepResult', status: 'passed' };
    }
    if (tool === 'get_editor_state' && text.startsWith('# Состояние редактора\n')) {
        const sections = [...text.matchAll(/^## (.+)$/gmu)].map(match => match[1]);
        if (sections[0] !== 'Открытые вкладки' || sections[1] !== 'Активный документ' ||
            sections.lastIndexOf('Открытые вкладки') !== 0 || sections.lastIndexOf('Активный документ') !== 1) { return { kind: 'unknown' }; }
        const tabs = /\n## Открытые вкладки\n([\s\S]*?)(?=\n## |$)/u.exec(text)![1];
        const document = /\n## Активный документ\n([\s\S]*?)(?=\n## |$)/u.exec(text)![1];
        const counts = [...tabs.matchAll(/^Количество: ([1-9]\d*)$/gmu)];
        const items = [...tabs.matchAll(/^- .+$/gmu)];
        const active = [...tabs.matchAll(/^- \*\*→\*\* (.+?)( \*\(изменена\)\*)?$/gmu)];
        const lines = [...document.matchAll(/^- Строка: ([1-9]\d*)$/gmu)];
        if (counts.length === 1 && items.length === Number(counts[0][1]) && active.length === 1 && /\.feature$/iu.test(active[0][1]) &&
            lines.length === 1 && Number.isSafeInteger(Number(lines[0][1]))) {
            const content = /^### Содержимое\n```gherkin\n([\s\S]*?)\n```(?:\n|$)/mu.exec(document);
            if (document.includes('### Содержимое') && (!content || document.indexOf('### Содержимое') !== document.lastIndexOf('### Содержимое'))) { return { kind: 'unknown' }; }
            return { kind: 'editor', featurePath: active[0][1], lineNumber: Number(lines[0][1]), dirty: !!active[0][2], ...(content ? { content: content[1] } : {}) };
        }
        return { kind: 'unknown' };
    }
    if (tool === 'run_scenario' && /^## Результат выполнения сценариев: все сценарии выполнены успешно\n\n(?:Имя сценария: [^\n]+\nРезультат прохождения сценария: Success\n?)+$/u.test(text)) {
        return { kind: 'runResult', status: 'passed', scenarioCount: [...text.matchAll(/^Результат прохождения сценария: Success$/gmu)].length };
    }
    if (tool === 'get_test_results' && text.startsWith('# Результаты тестов\n')) {
        const sections = text.split('\n## Шаги (');
        const header = sections[0].split('\n\nТехнические данные:\n');
        if (sections.length === 2 && header.length === 2 && /^- Статус: Failed$/mu.test(header[0])) {
            const count = /^([1-9]\d*)\)\n/u.exec(sections[1])?.[1];
            const steps = [...sections[1].matchAll(/^([1-9]\d*)\. [^\n]+ → \*\*(Success|Failed|Broken|Pending|Skipped)\*\*(?: \(\d+ мс\))?$/gmu)];
            const paths = [...header[1].matchAll(/^        ПолныйПутьКФиче: ([^\n]+\.feature)$/gmu)];
            const lines = [...header[1].matchAll(/^        НомерСтрокиФичи: ([1-9]\d*)$/gmu)];
            if (count && steps.length === Number(count) && steps.every((step, index) => Number(step[1]) === index + 1) &&
                steps.some(step => step[2] === 'Failed') && paths.length === 1 && lines.length === 1 && Number.isSafeInteger(Number(lines[0][1]))) {
                return { kind: 'failureResult', featurePath: paths[0][1], lineNumber: Number(lines[0][1]) };
            }
        }
        const parts = text.split('\n## Шаги (');
        const status = /^- Статус: (Success|Failed|Broken|Pending)$/mu.exec(parts[0])?.[1];
        const count = parts.length === 2 ? /^([1-9]\d*)\)\n/u.exec(parts[1])?.[1] : undefined;
        const rows = parts.length === 2 ? [...parts[1].matchAll(/^([1-9]\d*)\. [^\n]+ → \*\*(Success|Failed|Broken|Pending|Skipped)\*\*(?: \([^\n]* мс\))?$/gmu)] : [];
        if (!text.includes('Технические данные:') && count && status && rows.length === Number(count) && rows.every((row, index) => Number(row[1]) === index + 1)) {
            const errors = [...text.matchAll(/^- Ошибка: ([^\n]+)$/gmu)];
            if (status === 'Success' && rows.every(row => row[2] === 'Success')) { return { kind: 'runtimeResult', status: 'passed' }; }
            if (status !== 'Success' && rows.some(row => row[2] !== 'Success')) {
                return { kind: 'runtimeResult', status: status === 'Pending' ? 'pending' : 'failed', ...(errors.length ? { message: errors[0][1] } : {}) };
            }
        }
    }
    const loadedPrefix = 'В редактор был загружен фича файл, но ещё ни разу не запускался. Для получения подробной информации о загруженном файле нужно вызвать get_editor_state.\nИмя загруженного feature файла: ';
    if (tool === 'get_vanessa_automation_state' && text.startsWith(loadedPrefix)) {
        const featurePath = text.slice(loadedPrefix.length);
        if (/^[^\r\n]+\.feature$/iu.test(featurePath)) { return { kind: 'state', state: 'idle', featurePath }; }
        return { kind: 'unknown' };
    }
    if (tool === 'get_vanessa_automation_state' && text.startsWith('# Состояние Vanessa Automation\n')) {
        const initial = text.split('\n## ')[0];
        const flags = [...initial.matchAll(/^- Выполнение сценариев: (да|нет)$/gmu)];
        const client = [...initial.matchAll(/^- Клиент тестирования подключ[её]н: (да|нет)$/gmu)];
        const recording = [...initial.matchAll(/^- Включена запись действий пользователя: (да|нет)$/gmu)];
        // .45 writes the scenario result verbatim, including Markdown headings from
        // its error/window details. Only the outer state section names are structural.
        const stateText = text.replace(/^## (Текущая фича|Текущий сценарий|Текущий шаг) \(по данным прогона\)$/gmu, '## $1');
        const sections = ['Текущая фича', 'Текущий сценарий', 'Текущий шаг'];
        const headings = [...stateText.matchAll(/^## (.+)$/gmu)].map(match => match[1]).filter(heading => sections.includes(heading));
        if (flags.length !== 1 || client.length !== 1 ||
            sections.some((heading, index) => headings.indexOf(heading) !== index || headings.lastIndexOf(heading) !== index)) {
            return { kind: 'unknown' };
        }
        const feature = /(?:^|\n)## Текущая фича\n([\s\S]*?)(?=\n## |$)/u.exec(stateText)?.[1] ?? '';
        const step = /(?:^|\n)## Текущий шаг\n([\s\S]*?)(?=\n## |$)/u.exec(stateText)?.[1] ?? '';
        const featurePath = /^- fullPath: (.+)$/mu.exec(feature)?.[1];
        const line = /^- lineNumber: ([1-9]\d*)$/mu.exec(step)?.[1];
        const lineNumber = line ? Number(line) : undefined;
        const status = /^- status: (Running|Success|Failed|Broken|Pending)$/mu.exec(step)?.[1];
        const stepStatus = status ? ({ Running: 'running', Success: 'passed', Failed: 'failed', Broken: 'stopped', Pending: 'pending' } as const)[status as 'Running' | 'Success' | 'Failed' | 'Broken' | 'Pending'] : undefined;
        return { kind: 'state', state: flags[0][1] === 'да' ? 'running' : 'idle',
            ...(recording.length === 1 ? { recording: recording[0][1] === 'да' } : {}),
            ...(featurePath && featurePath !== 'не указано' ? { featurePath } : {}),
            ...(lineNumber && Number.isSafeInteger(lineNumber) ? { lineNumber } : {}), ...(stepStatus ? { stepStatus } : {}) };
    }
    if (tool === 'manage_breakpoints' && text.startsWith('# Точки останова\n')) {
        const section = text.split('\n## ')[0].trim();
        const paragraphs = section.split('\n\n');
        const hints = ['Загрузите фичи (`load_features`) и откройте сценарий для работы с точками останова.',
            'Редактор не доступен. Загрузите фичи (`load_features`) для инициализации.'];
        // .45 emits this hint even with open Monaco tabs; set/list/remove was verified live.
        // The caller must still verify the active saved file before and after every read.
        if (paragraphs[1] === 'Нет данных из редактора (обновятся при следующем обращении к редактору).') { return { kind: 'breakpointsUnavailable' }; }
        if (['Точек останова нет.', 'Точек останова нет (по данным редактора).'].includes(paragraphs[1])) {
            const advisory = paragraphs.slice(2).join('\n\n');
            if (/^Количество:|^- \d+$/mu.test(advisory)) { return { kind: 'unknown' }; }
            if (hints.some(hint => paragraphs.includes(hint))) { return { kind: 'breakpointsUnavailable' }; }
            return { kind: 'breakpoints', lines: [] };
        }
        const count = /^Количество: ([1-9]\d*)$/mu.exec(section)?.[1];
        const lines = [...section.matchAll(/^- ([1-9]\d*)$/gmu)].map(match => Number(match[1]));
        if (count && lines.length === Number(count) && lines.every(Number.isSafeInteger) && new Set(lines).size === lines.length) {
            return { kind: 'breakpoints', lines };
        }
    }
    return { kind: 'unknown' };
}
