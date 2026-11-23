import { getGherkinStepAnnotationTarget } from './gherkinAnnotations';
import { collectGherkinSyntaxErrors } from './gherkinSyntaxValidator.js';
import { parseStandaloneFeatureSource } from './standaloneFeatureModel';
import { nativeDocumentTextMatchesFileText } from './scenarioNativeDocumentSnapshot';
import { parseCompilerParameterBinding, scanCompilerLines } from './scenarioCompilerSyntax';
import { getFeatureEditorSteps, scanFeatureStructure } from './featureEditorActions';

export type VanessaFeatureRunMode = 'oneStep' | 'runFromLine' | 'runScenario';

export interface VanessaFeatureDocument {
    readonly uri: string; readonly filePath: string; readonly text: string; readonly dirty: boolean; readonly version: number; readonly line: number;
}

export interface VanessaFeatureFilePorts {
    current(): VanessaFeatureDocument | undefined;
    exists(filePath: string): Promise<boolean>;
    save(): Promise<boolean>;
    readText?(filePath: string): Promise<string>;
}

/** Document versions may restart at one after closing and reopening an editor. */
export function sameSavedVanessaFeature(source: VanessaFeatureDocument, current: Pick<VanessaFeatureDocument, 'uri' | 'text' | 'dirty'>): boolean {
    return source.uri === current.uri && source.text === current.text && !current.dirty;
}

export async function prepareSavedVanessaFeature(source: VanessaFeatureDocument, ports: VanessaFeatureFilePorts): Promise<VanessaFeatureDocument> {
    if (!source.uri.startsWith('file:') || !/\.feature$/iu.test(source.uri)) { throw new Error('Open a saved feature.'); }
    if (source.dirty && !await ports.save()) { throw new Error('Save the feature before executing a step.'); }
    if (!await ports.exists(source.filePath)) { throw new Error('The saved feature file could not be found.'); }
    if (ports.readText && !nativeDocumentTextMatchesFileText(source.text, await ports.readText(source.filePath))) { throw new Error('The saved feature changed on disk. Reopen it before executing a command.'); }
    const current = ports.current();
    if (!current || current.uri !== source.uri || current.text !== source.text || current.dirty) { throw new Error('The active feature changed. Run the command again.'); }
    return current;
}

export function isExecutableFeatureLine(source: VanessaFeatureDocument, line: number): boolean {
    if (!source.uri.startsWith('file:') || !/\.feature$/iu.test(source.uri) || !Number.isSafeInteger(line) || line < 0) { return false; }
    return !!getGherkinStepAnnotationTarget({ ...source, language: parseStandaloneFeatureSource(source.text, '').language }, line);
}

/** Syntactic F11 availability; the trial command also confirms adjacent SPPR metadata. */
export function isExecutableVanessaFragmentLine(source: VanessaFeatureDocument): boolean {
    if (!source.uri.startsWith('file:') || !/\/scen\.feature$/iu.test(source.uri) || !Number.isSafeInteger(source.line)) { return false; }
    const lines = source.text.split(/\r\n|\r|\n/u);
    const line = lines[source.line];
    return !!line?.trim() && scanCompilerLines(lines)[source.line].kind === 'code' && !parseCompilerParameterBinding(line);
}

/** Vanessa runFromLine accepts a step inside a tree group, not its heading. */
export function resolveVanessaStepLine(source: VanessaFeatureDocument, line: number, mode: 'oneStep' | 'runFromLine'): number {
    const lines = source.text.split(/\r\n|\n|\r/u);
    if (mode !== 'runFromLine' || !/^\s*\*/u.test(lines[line] ?? '')) { return line; }
    const width = /^[ \t]*/u.exec(lines[line])![0].length;
    for (let index = line + 1; index < lines.length; index++) {
        const text = lines[index];
        if (!text.trim() || /^\s*(?:#|\/\/|@)/u.test(text)) { continue; }
        if (/^[ \t]*/u.exec(text)![0].length <= width) { break; }
        if (!/^\s*\*/u.test(text) && isExecutableFeatureLine(source, index)) { return index; }
    }
    throw new Error('The selected group has no executable steps.');
}

/** Pick only lines belonging to the current scenario, even when the cursor is on its heading. */
function scenarioSelectionLines(source: VanessaFeatureDocument): number[] {
    const document = { ...source, language: parseStandaloneFeatureSource(source.text, '').language };
    const { lines, sections } = scanFeatureStructure(document);
    const cursor = lines[source.line];
    const section = cursor && sections.find(item => (item.kind === 'scenario' || item.kind === 'outline') &&
        cursor.start >= item.line.start && (cursor.start < item.end || cursor.start === source.text.length && item.end === cursor.start));
    if (!section) { throw new Error('Place the cursor inside a scenario in a saved feature.'); }
    const steps = getFeatureEditorSteps(document, section.line.number).filter(step => !step.text.startsWith('*'));
    if (!steps.length) { throw new Error('Vanessa needs a selectable step inside this scenario.'); }
    return steps.map(step => step.line + 1);
}

/** Native save and active-document checks precede every remote mutation. No work is queued on repeated F11. */
export class VanessaFeatureControl {
    private busy = false;
    constructor(private readonly ports: VanessaFeatureFilePorts & {
        execute(mode: VanessaFeatureRunMode, filePath: string, line: number, scenarioLines?: readonly number[]): Promise<number | void>;
        selectLine?(line: number): void;
    }) {}

    async run(mode: VanessaFeatureRunMode): Promise<void> {
        if (this.busy) { throw new Error('Vanessa is busy. Wait for the current command.'); }
        const source = this.ports.current();
        if (!source) { throw new Error('Open a saved feature.'); }
        let executionLine: number;
        let scenarioLines: number[] | undefined;
        if (mode === 'runScenario') {
            scenarioLines = scenarioSelectionLines(source);
            executionLine = scenarioLines[0];
        } else {
            if (!isExecutableFeatureLine(source, source.line)) { throw new Error('Place the cursor on an executable step in a saved feature.'); }
            const target = getGherkinStepAnnotationTarget({ ...source, language: parseStandaloneFeatureSource(source.text, '').language }, source.line)!;
            if (mode === 'runFromLine' && /^\s*(?:Background|Предыстория|Контекст)\s*:/iu.test(source.text.split(/\r?\n/u)[target.sectionLine] ?? '')) {
                throw new Error('Select a scenario step. Background cannot be a starting point.');
            }
            executionLine = resolveVanessaStepLine(source, source.line, mode) + 1;
        }
        if (collectGherkinSyntaxErrors(source.text).length) { throw new Error('Fix the feature syntax before executing a step.'); }
        this.busy = true;
        try {
            const saved = await prepareSavedVanessaFeature(source, this.ports);
            if (mode === 'runScenario' && saved.line !== source.line) { throw new Error('The active feature changed. Run the command again.'); }
            const next = scenarioLines
                ? await this.ports.execute(mode, source.filePath, executionLine, scenarioLines)
                : await this.ports.execute(mode, source.filePath, executionLine);
            const active = this.ports.current();
            if (mode === 'oneStep' && typeof next === 'number' && next > source.line + 1 && active && active.uri === source.uri && active.text === source.text &&
                !active.dirty && active.line === source.line && isExecutableFeatureLine(active, next - 1)) { this.ports.selectLine?.(next - 1); }
        } finally { this.busy = false; }
    }
}
