import { collectGherkinSyntaxErrors } from './gherkinSyntaxValidator';
import { resolveProjectInvocation } from './projectDefinitionMatcher';
import type { ProjectDefinitionView } from './projectDefinition';
import { collectCompilerParameterReferences, getCompilerScenarioBody, parseCompilerParameterBinding, scanCompilerLines } from './scenarioCompilerSyntax';
import { ScenarioYamlDocument } from './scenarioYamlDocument';
import { nativeDocumentTextMatchesFileText } from './scenarioNativeDocumentSnapshot';
import type { VanessaFeatureDocument } from './vanessaControlFeature';

export interface VanessaYamlTrial {
    readonly source: VanessaFeatureDocument;
    readonly featureText: string;
    readonly lineNumber: number;
    /** Zero-based source lines for runtime lines starting at lineNumber. */
    readonly sourceLines: readonly number[];
}

function indentationColumns(text: string): number {
    let columns = 0;
    for (const char of /^[ \t]*/u.exec(text)![0]) { columns += char === '\t' ? 4 - columns % 4 : 1; }
    return columns;
}

/** Remove indentation, preserving tabs in values and the remainder of a docstring. */
function withoutIndentation(text: string, columns: number): string {
    let index = 0; let consumed = 0;
    while (index < text.length && consumed < columns && /[ \t]/u.test(text[index])) {
        consumed += text[index++] === '\t' ? 4 - consumed % 4 : 1;
    }
    return ' '.repeat(Math.max(0, consumed - columns)) + text.slice(index);
}

/** A literal ordinary step only; compiler semantics must go through a certified build. */
export function prepareVanessaYamlTrial(source: VanessaFeatureDocument, definitions: ProjectDefinitionView, defaultLanguage: 'en' | 'ru' = 'en'): VanessaYamlTrial {
    const document = ScenarioYamlDocument.parse(source.text);
    const body = getCompilerScenarioBody(source.text);
    const line = body ? source.line - body.startLine : -1;
    const header = body ? source.text.split(/\r\n|\r|\n/u)[body.startLine - 1] : '';
    if (!source.uri.startsWith('file:') || !/\.yaml$/iu.test(source.uri) || document.errors.length || !body || !Number.isSafeInteger(line) ||
        line < 0 || line >= body.lines.length || !/:\s*\|[+-]?\s*(?:#.*)?$/u.test(header)) {
        throw new Error('Select a step in a saved YAML literal scenario text block.');
    }
    const scanned = scanCompilerLines(body.lines);
    if (scanned[line].kind !== 'code' || scanned[line].block || !body.lines[line].trim() || parseCompilerParameterBinding(body.lines[line])) {
        throw new Error('Select an ordinary Vanessa step. Compiler constructs require a build.');
    }
    let depth = 0;
    for (let index = 0; index < line; index++) {
        const block = scanned[index].block;
        if (block?.phase === 'open') { depth++; }
        else if (block?.phase === 'close') { depth--; }
    }
    if (depth !== 0) { throw new Error('Steps inside compiler control-flow blocks require a build.'); }
    const languageTags = body.lines.flatMap((text, index) => scanned[index].kind === 'comment'
        ? [...text.trim().matchAll(/^#\s*language\s*:\s*(\S+)\s*$/giu)].map(match => match[1].toLowerCase()) : []);
    const language = languageTags[0] ?? defaultLanguage;
    if (!['en', 'ru'].includes(language) || languageTags.some(value => value !== language)) { throw new Error('The YAML language must be unambiguously en or ru for a step trial.'); }
    const step = body.lines[line].trim();
    const prefix = language === 'en' ? /^(?:And|Given|When|Then|But)\s+\S/iu : /^(?:И|Дано|Допустим|Когда|Тогда|Но|К тому же)\s+\S/iu;
    if (!prefix.test(step)) { throw new Error('The selected step does not match the YAML language.'); }
    let end = line + 1;
    while (end < body.lines.length && ['docString', 'table'].includes(scanned[end].kind)) { end++; }
    const lines = body.lines.slice(line, end);
    if (collectCompilerParameterReferences(lines).length || lines.some(text => /<[^<>\r\n]+>/u.test(text))) {
        throw new Error('Parameter substitution requires a compiler build before a step trial.');
    }
    if (!definitions.all.some(definition => definition.kind === 'builtInStep')) {
        throw new Error('The Vanessa step catalog is unavailable. Check the configured Vanessa version and refresh its step catalog before trying a YAML step.');
    }
    const resolution = resolveProjectInvocation(definitions, step);
    if (resolution.kind !== 'unique' || resolution.match.definition.kind !== 'builtInStep') {
        throw new Error('This is not a uniquely resolved ordinary Vanessa step. Compile nested, exported or user-defined calls first.');
    }
    const argumentText = [...resolution.match.arguments.map(argument => argument.value), ...lines.slice(1).filter(text => !/^\s*(?:"""|```)/u.test(text))];
    // A runtime fragment has a different directory. Never silently reinterpret a file reference.
    if (/(?:\b(?:files?|folder|directory|path|attachment|image|picture)\b|файл|каталог|путь|папк|вложени|картин|изображени)/iu.test(resolution.match.definition.template) ||
        argumentText.some(value => /[/\\]|(?:^|[\s"'|])[^\s"'|]+\.[a-zа-я][a-zа-я0-9]{0,11}(?=$|[\s"'|])/iu.test(value))) {
        throw new Error('File and attachment arguments require a compiler build before a step trial.');
    }
    const indentation = indentationColumns(body.lines[line]);
    if (lines.some(text => text.trim() && indentationColumns(text) < indentation)) { throw new Error('Fix the step payload indentation before a step trial.'); }
    const payload = lines.map(text => text ? `    ${withoutIndentation(text, indentation)}` : '').join('\n');
    const featureText = language === 'ru'
        ? `# language: ru\nФункционал: KOT step trial\nСценарий: KOT step trial\n${payload}\n`
        : `# language: en\nFeature: KOT step trial\nScenario: KOT step trial\n${payload}\n`;
    if (collectGherkinSyntaxErrors(featureText).length) { throw new Error('Fix the step or its table/docstring syntax before a step trial.'); }
    return Object.freeze({ source, featureText, lineNumber: 4, sourceLines: Object.freeze(lines.map((_text, offset) => source.line + offset)) });
}

export interface VanessaYamlTrialPorts {
    current(): VanessaFeatureDocument | undefined;
    save(): Promise<boolean>;
    readText(file: string): Promise<string>;
    getDefinitions(source: VanessaFeatureDocument): Promise<ProjectDefinitionView>;
    defaultLanguage?(): 'en' | 'ru';
    materialize(trial: VanessaYamlTrial): Promise<string>;
    execute(file: string, trial: VanessaYamlTrial, isCurrent: () => boolean): Promise<void>;
}

export class VanessaYamlTrialControl {
    private busy = false;
    constructor(private readonly ports: VanessaYamlTrialPorts) {}
    async run(): Promise<void> {
        if (this.busy) { throw new Error('Vanessa is busy. Wait for the current command.'); }
        const source = this.ports.current();
        if (!source) { throw new Error('Select a step in a saved YAML scenario.'); }
        this.busy = true;
        const isCurrent = () => { const active = this.ports.current(); return active?.uri === source.uri && active.text === source.text && !active.dirty && active.line === source.line; };
        const assertCurrent = () => { if (!isCurrent()) { throw new Error('The active YAML source or selection changed. Run the command again.'); } };
        try {
            if (source.dirty && !await this.ports.save()) { throw new Error('Save the YAML source before trying a step.'); }
            if (!nativeDocumentTextMatchesFileText(source.text, await this.ports.readText(source.filePath))) { throw new Error('The YAML source changed on disk. Reopen it before trying a step.'); }
            assertCurrent();
            const definitions = await this.ports.getDefinitions(source); assertCurrent();
            const trial = prepareVanessaYamlTrial(source, definitions, this.ports.defaultLanguage?.());
            const file = await this.ports.materialize(trial); assertCurrent();
            await this.ports.execute(file, trial, isCurrent);
        } finally { this.busy = false; }
    }
}
