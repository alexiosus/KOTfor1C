import type { VanessaFeatureDocument } from './vanessaControlFeature';
import type { ProjectDefinitionView } from './projectDefinition';
import { prepareVanessaYamlTrial, type VanessaYamlTrial } from './vanessaControlYamlTrial';
import { getCompilerScenarioBody, scanCompilerLines } from './scenarioCompilerSyntax';
import { getGherkinSelectionFirstStep } from './gherkinAnnotations';
import { collectGherkinSyntaxErrors } from './gherkinSyntaxValidator';
import { parseStandaloneFeatureSource } from './standaloneFeatureModel';

export function isCompleteVanessaFeature(source: VanessaFeatureDocument): boolean {
    return source.uri.startsWith('file:') && /\.feature$/iu.test(source.uri) &&
        /^\uFEFF?[ \t]*(?:Feature|Functionality|Business Need|Ability|Функциональность|Функционал|Функция)[ \t]*:/imu.test(source.text);
}

function prepareFeatureSelection(source: VanessaFeatureDocument, lines: string[], start: number, end: number): VanessaYamlTrial {
    const { language } = parseStandaloneFeatureSource(source.text, '');
    const scanned = scanCompilerLines(lines);
    const isPayload = (index: number) => scanned[index]?.kind === 'table' || scanned[index]?.kind === 'docString';
    const first = getGherkinSelectionFirstStep({ ...source, language }, start, end);
    if (first === undefined) { throw new Error('Select steps inside the scenario text.'); }
    const next = scanned.findIndex((line, index) => index > end && lines[index].trim() && line.kind !== 'comment');
    if (scanned.slice(start, first).some((_line, index) => isPayload(start + index)) || isPayload(next)) {
        throw new Error('Include the complete step table or multiline string in the selection.');
    }
    if (scanned.slice(start, end + 1).some(line => line.block?.dialect === 'preprocessor')) {
        throw new Error('Select an ordinary Vanessa step. Compiler constructs require a build.');
    }

    const tree = scanned.slice(0, first).some((line, index) => line.kind === 'code' && /^\s*@tree(?:\s|$)/iu.test(lines[index]));
    const header = [`# language: ${language}`, ...(tree ? ['@tree'] : []),
        ...(language === 'ru' ? ['Функционал: KOT step trial', 'Сценарий: KOT step trial'] : ['Feature: KOT step trial', 'Scenario: KOT step trial'])];
    const payload = lines.slice(start, end + 1);
    if (payload.some((text, index) => scanned[start + index].kind !== 'comment' && /<[^<>\r\n]+>/u.test(text))) {
        throw new Error('Parameter substitution requires a compiler build before a step trial.');
    }
    // Vanessa resolves subscenario calls at runtime and rejects them as starting lines, like
    // groups and conditions. A zero delay provides a selectable first step in all these cases.
    const startStep = language === 'ru' ? 'И Пауза 0' : 'And Delay 0';
    const anchorIndent = /^[ \t]*/u.exec(lines[first])![0];
    const featureText = [...header, anchorIndent + startStep, ...payload, ''].join('\n');
    if (collectGherkinSyntaxErrors(featureText).length) { throw new Error('Fix the step or its table/docstring syntax before a step trial.'); }
    return Object.freeze({ source: { ...source, line: first }, featureText, lineNumber: header.length + 1,
        sourceLines: Object.freeze([first, ...payload.map((_line, index) => start + index)]) });
}

/** Selection is a separate bounded feature; surrounding preparation never slips into it. */
export function prepareVanessaSelection(source: VanessaFeatureDocument, start: number, end: number, definitions?: ProjectDefinitionView, defaultLanguage: 'en' | 'ru' = 'en'): VanessaYamlTrial {
    const lines = source.text.split(/\r\n|\r|\n/u);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= lines.length || end - start > 1_000) {
        throw new Error('Select a range of ordinary Vanessa steps (up to 1000 lines).');
    }
    if (isCompleteVanessaFeature(source)) { return prepareFeatureSelection(source, lines, start, end); }
    if (!definitions) { throw new Error('No project definition configuration is available for this resource.'); }
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
