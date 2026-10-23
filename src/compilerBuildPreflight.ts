import { findCompilerBuildParameter, isTruthyCompilerParameter, type CompilerBuildParameter } from './compilerBuildParameters';
import { collectCompilerBuildValueIssues } from './compilerBuildValueValidation';
import { collectCompilerFormatIssues, type CompilerFormatIssue } from './compilerFormatDiagnostics';
import { buildScenarioVariantPreview, parseScenarioParameterDefinitions, splitCompilerParameterVariants, type ScenarioParameterDefinition } from './scenarioParameterUtils';
import { ScenarioYamlDocument } from './scenarioYamlDocument';

export interface CompilerBuildPreflightSource { readonly uri: string; readonly text: string }
export interface CompilerBuildPreflightIssue {
    readonly code: string;
    readonly severity: 'error' | 'warning';
    readonly message: string;
    readonly messageArgs?: readonly (string | number)[];
    readonly uri?: string;
    readonly parameter?: string;
    readonly formatIssues?: readonly CompilerFormatIssue[];
}

type CompilerKind = 'сценарий' | 'процесс' | 'настройкатеста' | 'настройкапроцесса';
interface ParsedSource extends CompilerBuildPreflightSource { readonly kind: CompilerKind; readonly yaml: ScenarioYamlDocument }
const kinds: readonly CompilerKind[] = ['сценарий', 'процесс', 'настройкатеста', 'настройкапроцесса'];

function sourcePath(uri: string): string {
    try { return decodeURIComponent(new URL(uri).pathname); }
    catch { return uri; }
}
function field(source: ParsedSource, section: string, name: string): string {
    const value = source.yaml.findField(section, name)?.value;
    return value === null || value === undefined ? '' : String(value);
}
function identity(source: ParsedSource, section: string, name: string): string { return field(source, section, name).trim().toLowerCase(); }
function tagNames(source: ParsedSource, section: string): string[] {
    return source.yaml.readRecords(section).map(record => String(record.fields.get('Имя') ?? '').toLowerCase());
}
function scalarVariants(parameter: ScenarioParameterDefinition): number {
    if (parameter.type === 'table') { return 1; }
    const raw = parameter.rawDefaultValue?.trim();
    const quoted = raw && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
    const value = quoted ? raw.slice(1, -1).replace(/\\"/gu, '"').replace(/\\\\/gu, '\\') : parameter.value;
    return splitCompilerParameterVariants(value).length;
}

/** The supplied BSL combines settings/definition selectors with OR, then applies tags and DB as gates. */
function settingSelected(parameters: readonly CompilerBuildParameter[], settings: ParsedSource,
    roots: readonly ParsedSource[], definitions: readonly ParsedSource[]): boolean {
    const value = (...keys: string[]) => findCompilerBuildParameter(parameters, ...keys)?.value ?? '';
    const codes = (...keys: string[]) => value(...keys).split(/[; ]+/u).filter(Boolean);
    const scenarioCodes = codes('ScenarioFilter');
    const processCodes = codes('ProcessFilter');
    const scenarioSettingsCodes = codes('ScenarioSettingsFilter');
    const scenarioSettingsUids = codes('UIDScenarioSettingsFilter');
    const processSettingsCodes = codes('ProcessSettingsFilter');
    const isProcess = settings.kind === 'настройкапроцесса';
    if (!isProcess && field(settings, 'ДанныеТеста', 'Выключена').toLowerCase() === 'да') { return false; }
    const databases = codes('ModelDBid').map(code => code.toLowerCase());
    if (databases.length && !databases.includes(field(settings, 'ДанныеТеста', 'ИдентификаторБазы').toLowerCase())) { return false; }

    const visited = new Set<string>();
    const nestedScenarioCodes = new Set<string>();
    const nestedProcessCodes = new Set<string>();
    const visit = (source: ParsedSource) => {
        if (visited.has(source.uri)) { return; }
        visited.add(source.uri);
        const process = source.kind === 'процесс';
        (process ? nestedProcessCodes : nestedScenarioCodes).add(field(source, process ? 'ДанныеПроцесса' : 'ДанныеСценария', process ? 'ПолныйКод' : 'Код'));
        const follow = (kind: CompilerKind, uid: unknown) => {
            const key = String(uid ?? '').trim().toLowerCase();
            if (!key) { return; }
            for (const candidate of definitions) {
                if (candidate.kind === kind && identity(candidate, kind === 'процесс' ? 'ДанныеПроцесса' : 'ДанныеСценария', 'UID') === key) { visit(candidate); }
            }
        };
        if (process) {
            for (const step of source.yaml.readRecords('ШагиПроцесса')) {
                if (Number(step.fields.get('ТипШага')) === 0) { follow('сценарий', step.fields.get('СценарийUID')); }
                else if (Number(step.fields.get('ТипШага')) === 1) { follow('процесс', step.fields.get('ВложенныйПроцессUID')); }
            }
        } else {
            for (const child of source.yaml.readRecords('ВложенныеСценарии')) { follow('сценарий', child.fields.get('UIDВложенныйСценарий')); }
        }
    };
    roots.forEach(visit);
    const settingsFiltered = scenarioSettingsCodes.length + scenarioSettingsUids.length + processSettingsCodes.length > 0;
    const definitionsFiltered = scenarioCodes.length + processCodes.length > 0;
    const settingsMatch = isProcess ? processSettingsCodes.includes(field(settings, 'ДанныеТеста', 'Код'))
        : scenarioSettingsCodes.includes(field(settings, 'ДанныеТеста', 'Код')) || scenarioSettingsUids.includes(field(settings, 'ДанныеТеста', 'UID'));
    const definitionMatch = scenarioCodes.some(code => nestedScenarioCodes.has(code))
        || (isProcess && processCodes.some(code => nestedProcessCodes.has(code)));
    if (settingsFiltered && definitionsFiltered) {
        if (!isProcess && isTruthyCompilerParameter(value('ScenarioFilterHasPriority')) && !definitionMatch) { return false; }
        if (!settingsMatch && !definitionMatch) { return false; }
    } else if (settingsFiltered ? !settingsMatch : definitionsFiltered && !definitionMatch) { return false; }

    const tags = new Set([...tagNames(settings, 'ТегиТеста'), ...roots.flatMap(root => tagNames(root, isProcess ? 'ТегиПроцесса' : 'ТегиСценария'))]);
    // BSL trims neither individual tag names nor the semicolon-separated filter tokens.
    const includedTags = value('ОтборПоТегамСценариевИлиНастроек', 'FilterTags');
    if (includedTags.trim() && !includedTags.toLowerCase().split(';').some(tag => tags.has(tag))) { return false; }
    if (!isProcess) {
        const excludedTags = value('ИсключениеПоТегамСценариевИлиНастроек', 'ExceptionTags');
        if (excludedTags.trim() && excludedTags.toLowerCase().split(';').some(tag => tags.has(tag))) { return false; }
        const excludedCodes = codes('ExceptScenario');
        if (roots.some(root => excludedCodes.includes(field(root, 'ДанныеСценария', 'Код')))) { return false; }
    }
    return true;
}

/** Sources are the caller's enabled roots/settings and dependencies; this function never reads files or rewrites values. */
export function collectCompilerBuildPreflightIssues(parameters: readonly CompilerBuildParameter[],
    sources: readonly CompilerBuildPreflightSource[], enabledRootUris: readonly string[] = []): readonly CompilerBuildPreflightIssue[] {
    const result: CompilerBuildPreflightIssue[] = collectCompilerBuildValueIssues(parameters).map(issue => ({
        ...issue, severity: 'error', messageArgs: [issue.parameter]
    }));
    const parsed: ParsedSource[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
        if (seen.has(source.uri)) { continue; }
        seen.add(source.uri);
        const file = sourcePath(source.uri);
        if (!/\.ya?ml$/iu.test(file) || /\.kot\.ya?ml$/iu.test(file) || /(?:^|[\\/])\.kot(?:[\\/]|$)/iu.test(file)) { continue; }
        const yaml = ScenarioYamlDocument.parse(source.text);
        const type = yaml.findFieldAtPath(['ТипФайла']);
        const kind = String(type?.value ?? '').trim().toLowerCase();
        const descriptor = ['ДанныеСценария', 'ДанныеПроцесса', 'ДанныеТеста'].some(section => yaml.findSection(section));
        if (!kinds.includes(kind as CompilerKind)) {
            if (descriptor) { result.push({ code: 'unsupportedKind', severity: 'error', message: 'The selected descriptor must use one of the four compiler file types.', uri: source.uri }); }
            continue;
        }
        if (yaml.errors.length || type?.ambiguous) {
            result.push({ code: 'invalidYaml', severity: 'error', message: 'The selected compiler source has invalid or ambiguous YAML structure.', uri: source.uri });
            continue;
        }
        parsed.push({ ...source, kind: kind as CompilerKind, yaml });
        const format = collectCompilerFormatIssues(source.text, file);
        if (format.length) {
            const lines = [...new Set(format.map(issue => issue.line + 1))];
            result.push({ code: 'compilerFormat', severity: 'warning', uri: source.uri, formatIssues: format,
                message: 'Compiler format compatibility: {0} issue(s) on {1} line(s); first affected lines: {2}.',
                messageArgs: [format.length, lines.length, lines.slice(0, 8).join(', ') + (lines.length > 8 ? ', …' : '')] });
        }
    }
    const definitions = parsed.filter(source => source.kind === 'сценарий' || source.kind === 'процесс');
    const definitionsByUid = new Map<string, ParsedSource[]>();
    for (const source of definitions) {
        const uid = identity(source, source.kind === 'процесс' ? 'ДанныеПроцесса' : 'ДанныеСценария', 'UID');
        if (!uid) { continue; }
        const key = `${source.kind}:${uid}`; definitionsByUid.set(key, [...definitionsByUid.get(key) ?? [], source]);
    }
    for (const duplicates of definitionsByUid.values()) {
        if (duplicates.length > 1) { result.push({ code: 'ambiguousSourceUid', severity: 'error', uri: duplicates[0].uri,
            message: 'Multiple selected compiler definitions share the same source UID.' }); }
    }
    for (const selected of parsed.filter(source => source.kind === 'настройкатеста' || source.kind === 'настройкапроцесса')) {
        const process = selected.kind === 'настройкапроцесса';
        const linkName = process ? 'UIDПроцесса' : 'UIDСценария';
        const link = selected.yaml.findField('ДанныеТеста', linkName);
        const uid = identity(selected, 'ДанныеТеста', linkName);
        const roots = definitions.filter(source => source.kind === (process ? 'процесс' : 'сценарий') && uid
            && identity(source, process ? 'ДанныеПроцесса' : 'ДанныеСценария', 'UID') === uid);
        const definitionFilter = ['ScenarioFilter', 'ProcessFilter'].map(key => findCompilerBuildParameter(parameters, key))
            .find(parameter => parameter?.value.split(/[; ]+/u).some(Boolean));
        if (process && definitionFilter && roots.length === 1 && roots[0].yaml.readRecords('ШагиПроцесса')
            .some(step => Number(step.fields.get('ТипШага')) === 1)) {
            const databases = (findCompilerBuildParameter(parameters, 'ModelDBid')?.value ?? '').toLowerCase().split(/[; ]+/u).filter(Boolean);
            if (!databases.length || databases.includes(field(selected, 'ДанныеТеста', 'ИдентификаторБазы').toLowerCase())) {
                // Supplied BSL Подпроцессы uses ПроцессUID, but its reader only fills ВложенныйПроцессUID.
                // The phase integration adapts this case to an explicit ProcessSettingsFilter before preflight.
                result.push({ code: 'processFilterTraversalUnavailable', severity: 'warning', uri: selected.uri, parameter: definitionFilter.key,
                    message: 'The supplied compiler cannot reliably traverse nested processes for {0}. Adapt definition filters to explicit process settings before validating root parameter combinations.',
                    messageArgs: [definitionFilter.key] });
            }
            continue;
        }
        if (!settingSelected(parameters, selected, roots, definitions)) { continue; }
        const ambiguous = link?.ambiguous || roots.length > 1 || roots.some(root => root.yaml.findField(process ? 'ДанныеПроцесса' : 'ДанныеСценария', 'UID')?.ambiguous);
        if (!roots.length || ambiguous) {
            result.push({ code: ambiguous ? 'ambiguousSettingsSource' : 'missingSettingsSource', severity: 'error', uri: selected.uri,
                message: ambiguous ? 'The selected setting must link to exactly one source definition.' : 'The selected setting has no matching source definition for {0}.',
                ...(!ambiguous ? { messageArgs: [linkName] } : {}) });
            continue;
        }
        const root = roots[0];
        const count = process ? buildScenarioVariantPreview('', 0, selected.text).count : buildScenarioVariantPreview(root.text, 0, selected.text).count;
        if (BigInt(count) > 100n) {
            result.push({ code: 'variantLimit', severity: 'error', uri: selected.uri,
                message: 'The selected setting produces {0} parameter combinations; the supplied compiler supports at most {1}.', messageArgs: [count, 100] });
        }
        if (!process) { continue; }
        const exception = findCompilerBuildParameter(parameters, 'ИсключениеПоТегамСценариевИлиНастроек', 'ExceptionTags');
        if (exception?.value.trim()) { result.push({ code: 'processExceptionTags', severity: 'warning', uri: selected.uri, parameter: exception.key,
            message: 'The supplied compiler ignores {0} when selecting process settings.', messageArgs: [exception.key] }); }
        if (field(selected, 'ДанныеТеста', 'Выключена').toLowerCase() === 'да') {
            result.push({ code: 'processDisabledIgnored', severity: 'warning', uri: selected.uri, parameter: 'Выключена',
                message: 'The supplied compiler ignores Выключена in process settings; this setting will still be compiled.' });
        }
        const actual = parseScenarioParameterDefinitions(selected.text, 'ПараметрыТеста');
        for (const [name] of parseScenarioParameterDefinitions(root.text)) {
            if (!actual.has(name)) { result.push({ code: 'processMissingDefaults', severity: 'warning', uri: selected.uri, parameter: name,
                message: 'The root process parameter {0} is absent from the selected setting. The supplied compiler does not copy root process defaults.', messageArgs: [name] }); }
        }
        for (const [name, parameter] of actual) {
            if (scalarVariants(parameter) > 1) { result.push({ code: 'processMultipleValues', severity: 'warning', uri: selected.uri, parameter: name,
                message: 'The supplied compiler counts multiple values of process parameter {0} for the limit but does not generate separate process variants.', messageArgs: [name] }); }
        }
    }
    const rootUris = new Set(enabledRootUris);
    const configuredProcesses = new Set(parsed.filter(source => source.kind === 'настройкапроцесса')
        .map(source => identity(source, 'ДанныеТеста', 'UIDПроцесса')).filter(Boolean));
    for (const source of definitions) {
        if (source.kind !== 'процесс' || !rootUris.has(source.uri)) { continue; }
        const uid = identity(source, 'ДанныеПроцесса', 'UID');
        if (uid && !configuredProcesses.has(uid)) {
            result.push({ code: 'missingRootProcessSettings', severity: 'warning', uri: source.uri,
                message: 'The selected process has no launch settings. It can be compiled inside another process, but not as a separate test.' });
        }
    }
    return result;
}
