import {
    getSectionInsertion,
    ScenarioYamlDocument,
    type ScenarioYamlField,
    type SourceRange
} from './scenarioYamlDocument';

export interface ScenarioYamlContentMutation {
    changed: boolean;
    content: string;
}

export interface NestedScenarioRenameSource<T> {
    key: T;
    content: string;
    renameSelf?: boolean;
}

export interface PlannedNestedScenarioRename<T> {
    key: T;
    before: string;
    content: string;
    changed: boolean;
    updatedCallCount: number;
    updatedNestedSectionCount: number;
}

export interface ScenarioGroupRenameSource<T> {
    key: T;
    content: string;
    preparedContent?: string;
}

export interface PlannedScenarioGroupRename<T> {
    key: T;
    before: string;
    content: string;
    changed: boolean;
}

export interface ScenarioIdentityRenameSource<T> {
    key: T;
    content: string;
    kind: 'scenario' | 'test';
}

export interface PlannedScenarioIdentityRename<T> {
    key: T;
    before: string;
    content: string;
    changed: boolean;
}

interface SourceReplacement {
    range: SourceRange;
    text: string;
}

function getSourceNewline(source: string): '\n' | '\r\n' {
    return source.includes('\r\n') ? '\r\n' : '\n';
}

function applyReplacements(source: string, replacements: SourceReplacement[]): string {
    let content = source;
    for (const replacement of replacements.sort((left, right) => right.range.start - left.range.start)) {
        content = content.slice(0, replacement.range.start)
            + replacement.text
            + content.slice(replacement.range.end);
    }
    return content;
}

function requireEditableScalar(field: ScenarioYamlField, path: string): SourceRange {
    if (field.ambiguous || field.valueKind !== 'scalar' || !field.valueRange) {
        throw new Error(`Unsafe YAML edit: ${path} must be one unambiguous scalar`);
    }
    return field.valueRange;
}

function validateEditedContent(content: string): string {
    ScenarioYamlDocument.parse(content).requireValidForEdit();
    return content;
}

function updateScalarFields(
    source: string,
    sectionName: string,
    values: ReadonlyArray<readonly [string, string | undefined]>
): ScenarioYamlContentMutation {
    const document = ScenarioYamlDocument.parse(source);
    document.requireValidForEdit();
    const section = document.findFieldAtPath([sectionName]);
    if (section && (section.ambiguous || section.valueKind !== 'mapping')) {
        throw new Error(`Unsafe YAML edit: ${sectionName} must be one mapping`);
    }
    const replacements: SourceReplacement[] = [];

    for (const [fieldName, nextValue] of values) {
        if (nextValue === undefined) {
            continue;
        }
        const field = document.findField(sectionName, fieldName);
        if (!field) {
            continue;
        }
        const valueRange = requireEditableScalar(field, `${sectionName}.${fieldName}`);
        if (field.value !== nextValue) {
            replacements.push({ range: valueRange, text: JSON.stringify(nextValue) });
        }
    }

    return replacements.length === 0
        ? { changed: false, content: source }
        : { changed: true, content: validateEditedContent(applyReplacements(source, replacements)) };
}

export function updateScenarioGroupInMetadataContent(
    source: string,
    groupName: string
): ScenarioYamlContentMutation {
    const document = ScenarioYamlDocument.parse(source);
    document.requireValidForEdit();
    const field = document.findFieldAtPath(['KOTМетаданные', 'PhaseSwitcher', 'Tab']);
    if (field) {
        const valueRange = requireEditableScalar(field, 'KOTМетаданные.PhaseSwitcher.Tab');
        if (field.value === groupName) {
            return { changed: false, content: source };
        }
        return {
            changed: true,
            content: validateEditedContent(applyReplacements(source, [{
                range: valueRange,
                text: JSON.stringify(groupName)
            }]))
        };
    }

    const phaseSwitcher = document.findFieldAtPath(['KOTМетаданные', 'PhaseSwitcher']);
    if (phaseSwitcher) {
        if (phaseSwitcher.ambiguous || phaseSwitcher.valueKind !== 'mapping') {
            throw new Error('Unsafe YAML edit: KOTМетаданные.PhaseSwitcher must be one mapping');
        }
        const newline = getSourceNewline(source);
        const keyIndent = source.slice(phaseSwitcher.lineStart, phaseSwitcher.pairRange.start);
        const insertOffset = phaseSwitcher.pairRange.end;
        const leadingNewline = source.slice(0, insertOffset).endsWith(newline) ? '' : newline;
        const trailingNewline = insertOffset < source.length || source.endsWith(newline) ? newline : '';
        const insertion = `${leadingNewline}${keyIndent}    Tab: ${JSON.stringify(groupName)}${trailingNewline}`;
        return {
            changed: true,
            content: validateEditedContent(
                source.slice(0, insertOffset) + insertion + source.slice(insertOffset)
            )
        };
    }

    const metadata = document.findFieldAtPath(['KOTМетаданные']);
    if (!metadata) {
        return { changed: false, content: source };
    }
    if (metadata.ambiguous || metadata.valueKind !== 'mapping') {
        throw new Error('Unsafe YAML edit: KOTМетаданные must be one mapping');
    }
    const insertion = getSectionInsertion(
        source,
        'KOTМетаданные',
        `PhaseSwitcher:\n    Tab: ${JSON.stringify(groupName)}`
    );
    if (!insertion) {
        return { changed: false, content: source };
    }
    return {
        changed: true,
        content: validateEditedContent(
            source.slice(0, insertion.range.start) + insertion.text + source.slice(insertion.range.end)
        )
    };
}

export function updateScenarioDisplayNameInScenarioContent(
    source: string,
    scenarioName: string,
    scenarioCode?: string
): ScenarioYamlContentMutation {
    return updateScalarFields(source, 'ДанныеСценария', [
        ['Имя', scenarioName],
        ['Код', scenarioCode]
    ]);
}

export function updateScenarioDisplayNameInTestConfigContent(
    source: string,
    scenarioName: string,
    scenarioCode?: string
): ScenarioYamlContentMutation {
    return updateScalarFields(source, 'ДанныеТеста', [
        ['Имя', scenarioName],
        ['СценарийНаименование', scenarioName],
        ['Код', scenarioCode]
    ]);
}

export function updateNestedScenarioNameReferencesInScenarioContent(
    source: string,
    oldScenarioName: string,
    newScenarioName: string
): ScenarioYamlContentMutation & {
    updatedCallCount: number;
    updatedNestedSectionCount: number;
} {
    const previousName = oldScenarioName.trim();
    const nextName = newScenarioName.trim();
    if (!previousName || !nextName || previousName === nextName) {
        return {
            changed: false,
            content: source,
            updatedCallCount: 0,
            updatedNestedSectionCount: 0
        };
    }

    const document = ScenarioYamlDocument.parse(source);
    document.requireValidForEdit();
    const replacements: SourceReplacement[] = [];
    let updatedCallCount = 0;
    let updatedNestedSectionCount = 0;

    for (const field of document.findRecordFieldsForEdit('ВложенныеСценарии', 'ИмяСценария')) {
        const valueRange = requireEditableScalar(field, 'ВложенныеСценарии.ИмяСценария');
        if (field.value === previousName) {
            replacements.push({ range: valueRange, text: JSON.stringify(nextName) });
            updatedNestedSectionCount += 1;
        }
    }

    const textField = document.findFieldAtPath(['ТекстСценария']);
    if (textField) {
        if (
            textField.ambiguous
            || textField.valueKind !== 'blockScalar'
            || !textField.blockScalarContentRange
        ) {
            throw new Error('Unsafe YAML edit: ТекстСценария must be one block scalar');
        }
        const sectionStart = textField.blockScalarContentRange.start;
        const sectionText = source.slice(sectionStart, textField.blockScalarContentRange.end);
        const linePattern = /([^\r\n]*)(\r\n|\r|\n|$)/g;
        const callLinePattern = /^(\s*)(And|Then|When|Given|But|Но|Тогда|Когда|Если|И|К тому же|Допустим|Дано)(\s+)(.*)$/i;
        let lineMatch: RegExpExecArray | null;
        while ((lineMatch = linePattern.exec(sectionText)) !== null) {
            const line = lineMatch[1];
            if (line.length === 0 && lineMatch[2].length === 0) {
                break;
            }
            const callMatch = line.match(callLinePattern);
            if (!callMatch) {
                continue;
            }
            const body = callMatch[4] || '';
            const bodyMatch = body.match(/^(.*?)(\s+#.*)?$/);
            const rawMainPart = bodyMatch?.[1] ?? body;
            if (rawMainPart.trim() !== previousName) {
                continue;
            }
            const leadingWhitespace = rawMainPart.match(/^\s*/)?.[0] ?? '';
            const trailingWhitespace = rawMainPart.match(/\s*$/)?.[0] ?? '';
            const commentPart = bodyMatch?.[2] ?? '';
            const nextBody = `${leadingWhitespace}${nextName}${trailingWhitespace}${commentPart}`;
            const replacement = `${callMatch[1]}${callMatch[2]}${callMatch[3]}${nextBody}`;
            if (replacement !== line) {
                const start = sectionStart + lineMatch.index;
                replacements.push({ range: { start, end: start + line.length }, text: replacement });
                updatedCallCount += 1;
            }
        }
    }

    return replacements.length === 0
        ? {
            changed: false,
            content: source,
            updatedCallCount,
            updatedNestedSectionCount
        }
        : {
            changed: true,
            content: validateEditedContent(applyReplacements(source, replacements)),
            updatedCallCount,
            updatedNestedSectionCount
        };
}

export function planNestedScenarioRename<T>(
    sources: readonly NestedScenarioRenameSource<T>[],
    oldScenarioName: string,
    newScenarioName: string
): readonly PlannedNestedScenarioRename<T>[] {
    return sources.map(source => {
        let content = source.content;
        if (source.renameSelf) {
            content = updateScenarioDisplayNameInScenarioContent(content, newScenarioName).content;
        }
        const references = updateNestedScenarioNameReferencesInScenarioContent(
            content,
            oldScenarioName,
            newScenarioName
        );
        content = references.content;
        return {
            key: source.key,
            before: source.content,
            content,
            changed: content !== source.content,
            updatedCallCount: references.updatedCallCount,
            updatedNestedSectionCount: references.updatedNestedSectionCount
        };
    });
}

export async function planNestedScenarioRenameInChunks<T>(
    sources: readonly NestedScenarioRenameSource<T>[],
    oldScenarioName: string,
    newScenarioName: string,
    yieldControl: () => Promise<void> = () => new Promise(resolve => setImmediate(resolve))
): Promise<readonly PlannedNestedScenarioRename<T>[]> {
    const chunkSize = 32;
    const plan: PlannedNestedScenarioRename<T>[] = [];
    for (let start = 0; start < sources.length; start += chunkSize) {
        plan.push(...planNestedScenarioRename(
            sources.slice(start, start + chunkSize),
            oldScenarioName,
            newScenarioName
        ));
        if (start + chunkSize < sources.length) {
            await yieldControl();
        }
    }
    return plan;
}

export function planScenarioGroupRename<T>(
    sources: readonly ScenarioGroupRenameSource<T>[],
    groupName: string
): readonly PlannedScenarioGroupRename<T>[] {
    return sources.map(source => {
        const mutation = updateScenarioGroupInMetadataContent(
            source.preparedContent ?? source.content,
            groupName
        );
        return {
            key: source.key,
            before: source.content,
            content: mutation.content,
            changed: mutation.content !== source.content
        };
    });
}

export function planScenarioIdentityRename<T>(
    sources: readonly ScenarioIdentityRenameSource<T>[],
    scenarioName: string,
    scenarioCode?: string
): readonly PlannedScenarioIdentityRename<T>[] {
    return sources.map(source => {
        const mutation = source.kind === 'scenario'
            ? updateScenarioDisplayNameInScenarioContent(source.content, scenarioName, scenarioCode)
            : updateScenarioDisplayNameInTestConfigContent(source.content, scenarioName, scenarioCode);
        return {
            key: source.key,
            before: source.content,
            content: mutation.content,
            changed: mutation.changed
        };
    });
}
