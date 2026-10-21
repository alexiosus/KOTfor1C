import type { VanessaFeatureDocument } from './vanessaControlFeature';
import type { ProjectDefinitionView } from './projectDefinition';
import { prepareVanessaYamlTrial, type VanessaYamlTrial } from './vanessaControlYamlTrial';
import { getCompilerScenarioBody, scanCompilerLines } from './scenarioCompilerSyntax';

/** Selection is a separate bounded feature; surrounding preparation never slips into it. */
export function prepareVanessaSelection(source: VanessaFeatureDocument, start: number, end: number, definitions: ProjectDefinitionView, defaultLanguage: 'en' | 'ru' = 'en'): VanessaYamlTrial {
    const lines = source.text.split(/\r\n|\r|\n/u);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= lines.length || end - start > 1_000) {
        throw new Error('Select a range of ordinary Vanessa steps (up to 1000 lines).');
    }
    const feature = /\.feature$/iu.test(source.uri);
    const offset = feature ? 2 : 0;
    const converted = feature ? { ...source, uri: source.uri + '.yaml', text: 'ТипФайла: "Сценарий"\nТекстСценария: |\n' + lines.map(line => `    ${line}`).join('\n') } : source;
    const body = getCompilerScenarioBody(converted.text);
    if (!body || start + offset < body.startLine) { throw new Error('Select steps inside the scenario text.'); }
    const scanned = scanCompilerLines(body.lines);
    const fragments: VanessaYamlTrial[] = [];
    for (let line = start; line <= end; line++) {
        const index = line + offset - body.startLine;
        if (!body.lines[index]?.trim() || scanned[index]?.kind === 'comment') { continue; }
        const trial = prepareVanessaYamlTrial({ ...converted, line: line + offset }, definitions, defaultLanguage);
        if (trial.sourceLines.at(-1)! - offset > end) { throw new Error('Include the complete step table or multiline string in the selection.'); }
        fragments.push(trial); line = trial.sourceLines.at(-1)! - offset;
    }
    if (!fragments.length) { throw new Error('Select at least one ordinary Vanessa step.'); }
    const header = fragments[0].featureText.split('\n').slice(0, 3).join('\n') + '\n';
    const payload = fragments.map(trial => trial.featureText.split('\n').slice(3).join('\n')).join('');
    return Object.freeze({ source: { ...source, line: start }, lineNumber: 4, featureText: header + payload,
        sourceLines: Object.freeze(fragments.flatMap(trial => trial.sourceLines.map(line => line - offset))) });
}
