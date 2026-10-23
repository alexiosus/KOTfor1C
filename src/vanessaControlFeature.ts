import { getGherkinStepAnnotationTarget } from './gherkinAnnotations';
import { collectGherkinSyntaxErrors } from './gherkinSyntaxValidator.js';
import { parseStandaloneFeatureSource } from './standaloneFeatureModel';
import { nativeDocumentTextMatchesFileText } from './scenarioNativeDocumentSnapshot';

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

/** Native save and active-document checks precede every remote mutation. No work is queued on repeated F11. */
export class VanessaFeatureControl {
    private busy = false;
    constructor(private readonly ports: VanessaFeatureFilePorts & {
        execute(mode: 'oneStep' | 'runFromLine', filePath: string, line: number): Promise<number | void>;
        selectLine?(line: number): void;
    }) {}

    async run(mode: 'oneStep' | 'runFromLine'): Promise<void> {
        if (this.busy) { throw new Error('Vanessa is busy. Wait for the current command.'); }
        const source = this.ports.current();
        if (!source || !isExecutableFeatureLine(source, source.line)) { throw new Error('Place the cursor on an executable step in a saved feature.'); }
        const target = getGherkinStepAnnotationTarget({ ...source, language: parseStandaloneFeatureSource(source.text, '').language }, source.line)!;
        if (mode === 'runFromLine' && /^\s*(?:Background|Предыстория|Контекст)\s*:/iu.test(source.text.split(/\r?\n/u)[target.sectionLine] ?? '')) {
            throw new Error('Select a scenario step. Background cannot be a starting point.');
        }
        if (collectGherkinSyntaxErrors(source.text).length) { throw new Error('Fix the feature syntax before executing a step.'); }
        let executionLine = source.line;
        const lines = source.text.split(/\r\n|\n|\r/u);
        if (mode === 'runFromLine' && /^\s*\*/u.test(lines[source.line])) {
            // Native run_scenario rejects tree headings even though they are
            // valid editor annotation targets. Stay strictly inside this group.
            const width = target.indentation.length;
            executionLine = -1;
            for (let index = source.line + 1; index < lines.length; index++) {
                const text = lines[index];
                if (!text.trim() || /^\s*(?:#|\/\/|@)/u.test(text)) { continue; }
                if (/^[ \t]*/u.exec(text)![0].length <= width) { break; }
                if (!/^\s*\*/u.test(text) && isExecutableFeatureLine(source, index)) { executionLine = index; break; }
            }
            if (executionLine < 0) { throw new Error('The selected group has no executable steps.'); }
        }
        this.busy = true;
        try {
            await prepareSavedVanessaFeature(source, this.ports);
            const next = await this.ports.execute(mode, source.filePath, executionLine + 1);
            const active = this.ports.current();
            if (mode === 'oneStep' && typeof next === 'number' && next > source.line + 1 && active && active.uri === source.uri && active.text === source.text &&
                !active.dirty && active.line === source.line && isExecutableFeatureLine(active, next - 1)) { this.ports.selectLine?.(next - 1); }
        } finally { this.busy = false; }
    }
}
