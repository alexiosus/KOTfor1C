import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UserStepSourceParseResult } from './bslStepSourceParser';
import {
    extractExportScenarioQuotedValues,
    suggestedExportScenarioParameterName
} from './exportScenarioCreator';
import type { ProjectDefinitionPosition } from './projectDefinition';

export interface VanessaTemplateConfiguration {
    readonly workspaceFolderPath: string;
    readonly buildParameters: readonly { readonly key: string; readonly value: string }[];
    readonly configuredVanessaEpfPath?: string;
}

export interface UserStepSourceEditRequest {
    readonly source: string;
    readonly documentVersion: number;
    readonly expectedVersion: number;
    readonly template: string;
    readonly parameterNames: readonly string[];
    readonly implementationName: string;
    readonly implementationKind: 'procedure' | 'function';
    readonly description: string;
    readonly category: string;
}

export interface UserStepSourceTextEdit {
    readonly startOffset: number;
    readonly endOffset: number;
    readonly newText: string;
}

export interface UserStepSourceEditPlan {
    readonly documentVersion: number;
    readonly edits: readonly UserStepSourceTextEdit[];
    readonly cursor: { readonly line: number; readonly character: number };
    readonly implementationRange: {
        readonly start: { readonly line: number; readonly character: number };
        readonly end: { readonly line: number; readonly character: number };
    };
}

export interface CreateNewUserStepLibraryRequest {
    readonly libraryRootPath: string;
    readonly libraryName: string;
    readonly templateRoot: string;
    readonly step: UserStepSourceEditRequest;
}

export interface NewUserStepLibrarySourceResult {
    readonly sourceDirectory: string;
    readonly rootXmlPath: string;
    readonly modulePath: string;
    readonly targetEpfPath: string;
}

const TEMPLATE_METADATA_FILES = Object.freeze([
    'Обработка.xml',
    path.join('Обработка', 'Forms', 'Форма.xml'),
    path.join('Обработка', 'Forms', 'Форма', 'Ext', 'Form.xml')
]);
const MODULE_RELATIVE_PATH = path.join('Обработка', 'Forms', 'Форма', 'Ext', 'Form', 'Module.bsl');
const VANESSA_ALIASES = new Set(['vanessafolder', 'vanessadir', 'vanessapath']);

function stripOuterQuotes(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return trimmed.slice(1, -1).trim();
        }
    }
    return trimmed;
}

function resolveCandidate(workspaceFolderPath: string, value: string): string | null {
    const normalizedValue = stripOuterQuotes(value);
    if (!normalizedValue) {
        return null;
    }
    const absolute = path.isAbsolute(normalizedValue)
        ? path.normalize(normalizedValue)
        : path.resolve(workspaceFolderPath, normalizedValue);
    const vanessaRoot = path.extname(absolute).toLocaleLowerCase() === '.epf'
        ? path.dirname(absolute)
        : absolute;
    return path.join(vanessaRoot, 'lib', 'TemplateEpfUF');
}

export function resolveVanessaTemplateRoot(configuration: VanessaTemplateConfiguration): string | null {
    for (const parameter of configuration.buildParameters) {
        if (!VANESSA_ALIASES.has(parameter.key.trim().toLocaleLowerCase())) {
            continue;
        }
        const resolved = resolveCandidate(configuration.workspaceFolderPath, parameter.value);
        if (resolved) {
            return resolved;
        }
    }
    return resolveCandidate(configuration.workspaceFolderPath, configuration.configuredVanessaEpfPath ?? '');
}

function offsetAtPosition(source: string, target: ProjectDefinitionPosition): number {
    let line = 0;
    let index = 0;
    while (line < target.line && index < source.length) {
        if (source[index] === '\r') {
            index += source[index + 1] === '\n' ? 2 : 1;
            line += 1;
        } else if (source[index] === '\n') {
            index += 1;
            line += 1;
        } else {
            index += 1;
        }
    }
    return Math.min(index + target.character, source.length);
}

function positionAtOffset(source: string, offset: number): { line: number; character: number } {
    let line = 0;
    let character = 0;
    for (let index = 0; index < Math.min(offset, source.length); index++) {
        if (source[index] === '\r') {
            if (source[index + 1] === '\n') {
                index += 1;
            }
            line += 1;
            character = 0;
        } else if (source[index] === '\n') {
            line += 1;
            character = 0;
        } else {
            character += 1;
        }
    }
    return { line, character };
}

function lineAt(source: string, lineNumber: number): string {
    let start = 0;
    for (let line = 0; line < lineNumber; line++) {
        const newline = source.indexOf('\n', start);
        if (newline < 0) {
            return '';
        }
        start = newline + 1;
    }
    const newline = source.indexOf('\n', start);
    const value = source.slice(start, newline < 0 ? source.length : newline);
    return value.endsWith('\r') ? value.slice(0, -1) : value;
}

function leadingWhitespace(value: string): string {
    let end = 0;
    while (end < value.length && (value[end] === ' ' || value[end] === '\t')) {
        end += 1;
    }
    return value.slice(0, end);
}

function escapeBslString(value: string): string {
    return value.replace(/\r\n?|\n/gu, ' ').replace(/"/gu, '""');
}

function validateIdentifier(value: string, label: string): string {
    const result = value.trim();
    if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(result)) {
        throw new Error(`${label} must be a valid BSL identifier.`);
    }
    return result;
}

function preparedStep(request: UserStepSourceEditRequest): {
    readonly template: string;
    readonly parameterNames: readonly string[];
    readonly implementationName: string;
} {
    const quoted = extractExportScenarioQuotedValues(request.template);
    if (quoted.length !== request.parameterNames.length) {
        throw new Error(`Expected ${quoted.length} parameter names, received ${request.parameterNames.length}.`);
    }
    const parameterNames = request.parameterNames.map((value, index) =>
        validateIdentifier(suggestedExportScenarioParameterName(value, index), 'Parameter name')
    );
    const seen = new Set<string>();
    for (const name of parameterNames) {
        const key = name.toLocaleLowerCase();
        if (seen.has(key)) {
            throw new Error(`Duplicate parameter name: ${name}.`);
        }
        seen.add(key);
    }
    let template = request.template.trim();
    if (!template) {
        throw new Error('User-step template must not be empty.');
    }
    for (let index = quoted.length - 1; index >= 0; index--) {
        template = template.slice(0, quoted[index].start)
            + parameterNames[index]
            + template.slice(quoted[index].end);
    }
    return {
        template,
        parameterNames,
        implementationName: validateIdentifier(request.implementationName, 'Implementation name')
    };
}

function registrationLine(
    step: ReturnType<typeof preparedStep>,
    request: UserStepSourceEditRequest,
    indent: string
): string {
    const argumentsList = step.parameterNames.map(name => `Знач ${name}`).join(', ');
    const snippet = `${step.implementationName}(${argumentsList})`;
    return `${indent}Ванесса.ДобавитьШагВМассивТестов(`
        + `ВсеТесты, "${escapeBslString(snippet)}", "${escapeBslString(step.implementationName)}", `
        + `"${escapeBslString(step.template)}", "${escapeBslString(request.description.trim())}", `
        + `"${escapeBslString(request.category.trim())}");`;
}

function implementationBlock(
    step: ReturnType<typeof preparedStep>,
    request: UserStepSourceEditRequest,
    eol: string,
    indent: string
): { text: string; headerLength: number; cursorInBlock: number } {
    const parameters = step.parameterNames.join(', ');
    const isFunction = request.implementationKind === 'function';
    const keyword = isFunction ? 'Функция' : 'Процедура';
    const endKeyword = isFunction ? 'КонецФункции' : 'КонецПроцедуры';
    const header = `&НаКлиенте${eol}${keyword} ${step.implementationName}(${parameters}) Экспорт`;
    const body = isFunction ? `${indent}Возврат Неопределено;` : `${indent}// TODO: реализовать шаг`;
    return {
        text: `${header}${eol}${body}${eol}${endKeyword}`,
        headerLength: `&НаКлиенте${eol}${keyword} `.length,
        cursorInBlock: header.length + eol.length + indent.length
    };
}

function applyEdits(source: string, edits: readonly UserStepSourceTextEdit[]): string {
    return [...edits]
        .sort((left, right) => right.startOffset - left.startOffset)
        .reduce(
            (current, edit) => current.slice(0, edit.startOffset) + edit.newText + current.slice(edit.endOffset),
            source
        );
}

export function planUserStepSourceEdit(
    parsed: UserStepSourceParseResult,
    request: UserStepSourceEditRequest
): UserStepSourceEditPlan {
    if (request.documentVersion !== request.expectedVersion) {
        throw new Error('The document changed while the user step was being created. Please retry.');
    }
    if (!parsed.registrationInsertionRange || !parsed.moduleAppendRange) {
        throw new Error('The BSL parser did not provide a safe insertion point for this module.');
    }
    const step = preparedStep(request);
    if (parsed.declarations.some(item =>
        item.name.toLocaleLowerCase() === step.implementationName.toLocaleLowerCase()
    )) {
        throw new Error(`Implementation ${step.implementationName} already exists.`);
    }

    const eol = request.source.includes('\r\n') ? '\r\n' : '\n';
    const registrationOffset = offsetAtPosition(request.source, parsed.registrationInsertionRange.start);
    const appendOffset = offsetAtPosition(request.source, parsed.moduleAppendRange.start);
    const registrationIndent = leadingWhitespace(lineAt(
        request.source,
        parsed.registrationInsertionRange.start.line
    )) || '    ';
    const bodyIndent = registrationIndent;
    const registrationText = registrationLine(step, request, registrationIndent) + eol + eol;
    const prefix = request.source.endsWith('\n') || request.source.endsWith('\r') ? eol : eol + eol;
    const implementation = implementationBlock(step, request, eol, bodyIndent);
    const implementationText = prefix + implementation.text + eol;
    const edits: UserStepSourceTextEdit[] = [
        { startOffset: registrationOffset, endOffset: registrationOffset, newText: registrationText },
        { startOffset: appendOffset, endOffset: appendOffset, newText: implementationText }
    ];
    const result = applyEdits(request.source, edits);
    const finalImplementationOffset = appendOffset + registrationText.length + prefix.length;
    const nameStart = finalImplementationOffset + implementation.headerLength;
    return Object.freeze({
        documentVersion: request.documentVersion,
        edits: Object.freeze(edits.map(edit => Object.freeze(edit))),
        cursor: Object.freeze(positionAtOffset(
            result,
            finalImplementationOffset + implementation.cursorInBlock
        )),
        implementationRange: Object.freeze({
            start: Object.freeze(positionAtOffset(result, nameStart)),
            end: Object.freeze(positionAtOffset(result, nameStart + step.implementationName.length))
        })
    });
}

function createNewModule(request: UserStepSourceEditRequest): string {
    const step = preparedStep(request);
    const eol = '\n';
    const indent = '    ';
    const implementation = implementationBlock(step, request, eol, indent);
    return '\uFEFF'
        + `&НаКлиенте${eol}`
        + `Функция ПолучитьСписокТестов(КонтекстФреймворкаBDD) Экспорт${eol}`
        + `${indent}Ванесса = КонтекстФреймворкаBDD;${eol}`
        + `${indent}ВсеТесты = Новый Массив;${eol}${eol}`
        + registrationLine(step, request, indent) + eol + eol
        + `${indent}Возврат ВсеТесты;${eol}`
        + `КонецФункции${eol}${eol}`
        + implementation.text + eol;
}

export async function createNewUserStepLibrarySource(
    request: CreateNewUserStepLibraryRequest
): Promise<NewUserStepLibrarySourceResult> {
    const libraryName = validateIdentifier(request.libraryName, 'Library name');
    const sourceDirectory = path.join(request.libraryRootPath, 'step_definitions-src', libraryName);
    const rootXmlPath = path.join(sourceDirectory, 'Обработка.xml');
    const modulePath = path.join(sourceDirectory, MODULE_RELATIVE_PATH);
    const targetEpfPath = path.join(request.libraryRootPath, 'step_definitions', `${libraryName}.epf`);

    try {
        await fs.promises.stat(sourceDirectory);
        throw new Error(`User-step source library already exists: ${sourceDirectory}`);
    } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
            throw error;
        }
    }
    for (const relativePath of [...TEMPLATE_METADATA_FILES, MODULE_RELATIVE_PATH]) {
        const sourcePath = path.join(request.templateRoot, relativePath);
        const stat = await fs.promises.stat(sourcePath).catch(() => null);
        if (!stat?.isFile()) {
            throw new Error(`Vanessa TemplateEpfUF is incomplete: ${sourcePath}`);
        }
    }

    await fs.promises.mkdir(sourceDirectory, { recursive: true });
    try {
        for (const relativePath of TEMPLATE_METADATA_FILES) {
            const sourcePath = path.join(request.templateRoot, relativePath);
            const targetPath = path.join(sourceDirectory, relativePath);
            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.promises.copyFile(sourcePath, targetPath);
        }
        await fs.promises.mkdir(path.dirname(modulePath), { recursive: true });
        await fs.promises.writeFile(modulePath, createNewModule(request.step), 'utf8');
    } catch (error) {
        await fs.promises.rm(sourceDirectory, { recursive: true, force: true });
        throw error;
    }

    return Object.freeze({ sourceDirectory, rootXmlPath, modulePath, targetEpfPath });
}
