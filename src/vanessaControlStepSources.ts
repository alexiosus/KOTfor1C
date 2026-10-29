import { collectGherkinExecutableLines } from './gherkinAnnotations';
import { parseExportScenarios } from './exportScenarioParser';
import { extractExportScenarioQuotedValues } from './exportScenarioCreator';
import { scanFeatureStructure } from './featureEditorActions';
import { resolveProjectInvocation } from './projectDefinitionMatcher';
import type { ProjectDefinitionView } from './projectDefinition';
import { scanCompilerLines } from './scenarioCompilerSyntax';
import type { VanessaResultSourceMap, VanessaResultStepSource } from './vanessaControlStepResults';

/** Capture saved export bodies, without changing the feature sent to Vanessa. */
export async function prepareVanessaResultSources(source: string, definitions: ProjectDefinitionView,
    readText: (uri: string) => Promise<string>): Promise<VanessaResultSourceMap | undefined> {
    if (!definitions.all.some(definition => definition.kind === 'exportScenario')) { return undefined; }
    const files = new Map<string, Promise<string>>();
    const read = (uri: string) => {
        let pending = files.get(uri);
        if (!pending) { pending = readText(uri); files.set(uri, pending); }
        return pending;
    };
    let expanded = false; let remaining = 10_000;
    const expand = async (text: string, seen: ReadonlySet<string>): Promise<readonly string[] | undefined> => {
        if (--remaining < 0) { return undefined; }
        const resolution = resolveProjectInvocation(definitions, text);
        if (resolution.kind !== 'unique' || resolution.match.definition.kind !== 'exportScenario') { return [text]; }
        const { definition, arguments: arguments_ } = resolution.match;
        const location = definition.definitionLocation;
        if (!location || seen.has(definition.id) || seen.size >= 16 || definition.parameters.some(parameter => parameter.source !== 'quoted')) { return undefined; }
        try {
            const saved = await read(location.uri);
            const language = definition.language ?? 'en';
            const parsed = parseExportScenarios(saved, { sourceUri: location.uri, workspaceFolderUri: '', profileId: '',
                libraryRootUri: '', sourceLabel: '', defaultLanguage: language });
            const declaration = parsed.scenarios.find(item => item.titleRange.start.line === location.range.start.line && item.exported && item.title === definition.template);
            const structure = scanFeatureStructure({ uri: location.uri, version: 0, text: saved, language: parsed.language });
            const section = structure.sections.find(item => item.line.number === location.range.start.line);
            if (!declaration || !section || section.kind !== 'scenario' || structure.unclosedDocString ||
                structure.sections.some(item => ['background', 'variables', 'rule'].includes(item.kind))) { return undefined; }
            const body = saved.slice(section.line.fullEnd, section.end);
            // Dynamic branches/loops do not have a statically provable result sequence.
            if (scanCompilerLines(body.split(/\r\n|\r|\n/u)).some(line => line.block)) { return undefined; }
            const prefix = parsed.language === 'ru' ? '# language: ru\nФункционал: Export\nСценарий: Export\n'
                : '# language: en\nFeature: Export\nScenario: Export\n';
            const children = collectGherkinExecutableLines({ text: prefix + body, uri: location.uri, language: parsed.language });
            if (!children.length || children.some(child => child.text.startsWith('*'))) { return undefined; }
            const next = new Set(seen); next.add(definition.id);
            const result: string[] = [];
            for (const child of children) {
                let substituted = child.text;
                for (const value of [...extractExportScenarioQuotedValues(child.text)].reverse()) {
                    const argument = arguments_.find(item => item.parameter.name === value.value);
                    if (argument) { substituted = substituted.slice(0, value.start) + argument.value + substituted.slice(value.end); }
                }
                const leaves = await expand(substituted, next);
                if (!leaves) { return undefined; }
                result.push(...leaves);
            }
            expanded = true;
            return result;
        } catch { return undefined; }
    };
    const steps: VanessaResultStepSource[] = [];
    for (const line of collectGherkinExecutableLines({ text: source, uri: 'file:///runtime.feature', language: 'en' })) {
        const leaves = await expand(line.text, new Set());
        for (const text of leaves ?? [line.text]) { steps.push({ lineNumber: line.lineNumber, text }); }
    }
    if (!expanded) { return undefined; }
    return { steps, isCurrent: async () => {
        try { return (await Promise.all([...files].map(async ([uri, saved]) => await readText(uri) === await saved))).every(Boolean); }
        catch { return false; }
    } };
}
