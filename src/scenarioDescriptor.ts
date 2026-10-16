import { parseKotScenarioDescription } from './kotMetadataDescription';
import { parsePhaseSwitcherMetadata } from './phaseSwitcherMetadata';
import {
    extractScenarioParameterNameFromText,
    normalizeScenarioCallParameterValue
} from './scenarioParameterUtils';
import {
    ScenarioYamlDocument,
    type ScenarioYamlField,
    type ScenarioYamlRecord
} from './scenarioYamlDocument';
import type { ProcessStepReference, TestInfo } from './types';

export interface ParsedScenarioDescriptor {
    readonly catalogValues?: TestInfo['catalogValues'];
    readonly kind?: 'process';
    readonly processCode?: string;
    readonly processSteps?: readonly ProcessStepReference[];
    readonly name?: string;
    readonly uid?: string;
    readonly scenarioCode?: string;
    readonly scenarioCodeLine?: number;
    readonly scenarioCodeLineStartCharacter?: number;
    readonly scenarioCodeLineEndCharacter?: number;
    readonly parameters?: readonly string[];
    readonly parameterDefaults?: Readonly<Record<string, string>>;
    readonly parameterTypes?: Readonly<Record<string, 'scalar' | 'table'>>;
    readonly nestedScenarioNames?: readonly string[];
    readonly scenarioDescription?: string;
    readonly scenarioCategory?: string;
    readonly phaseSwitcher: {
        readonly hasTab: boolean;
        readonly tabName?: string;
        readonly order?: number;
    };
}

export interface ParsedTestSettingsTarget {
    readonly kind: 'scenario' | 'process';
    readonly uid: string;
}

/** Reuse settings already read by discovery to identify main scenarios without KOT tags. */
export function parseTestSettingsTarget(source: string): ParsedTestSettingsTarget | undefined {
    if (!/^\uFEFF?ТипФайла\s*:\s*["']?Настройка/mu.test(source)) { return undefined; }
    const yaml = ScenarioYamlDocument.parse(source);
    if (yaml.errors.length) { return undefined; }
    const type = yaml.findFieldAtPath(['ТипФайла']);
    if (!type || type.ambiguous) { return undefined; }
    const kind = type.value === 'НастройкаТеста' ? 'scenario' : type.value === 'НастройкаПроцесса' ? 'process' : undefined;
    if (!kind) { return undefined; }
    const link = yaml.findField('ДанныеТеста', kind === 'scenario' ? 'UIDСценария' : 'UIDПроцесса');
    const uid = link && !link.ambiguous ? trimOptional(link.value) : undefined;
    return uid ? { kind, uid: uid.toLowerCase() } : undefined;
}

function trimOptional(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function unique(values: readonly string[]): string[] | undefined {
    const result = [...new Set(values.filter(value => value.length > 0))];
    return result.length > 0 ? result : undefined;
}

function getRecordString(record: ScenarioYamlRecord, key: string): string | undefined {
    return trimOptional(record.fields.get(key));
}

function readParameterDefaults(records: readonly ScenarioYamlRecord[]): Map<string, string> {
    const defaults = new Map<string, string>();
    for (const record of records) {
        const rawName = getRecordString(record, 'Имя');
        if (!rawName) {
            continue;
        }
        const name = extractScenarioParameterNameFromText(rawName);
        if (!name || defaults.has(name)) {
            continue;
        }
        defaults.set(
            name,
            record.fields.get('ТипПараметра') === 'Таблица'
                ? getRecordString(record, 'Значение') ?? ''
                : normalizeScenarioCallParameterValue(typeof record.fields.get('Значение') === 'string'
                    ? record.fields.get('Значение') as string : undefined, name)
        );
    }
    return defaults;
}

function getLineNumber(source: string, offset: number): number {
    let line = 0;
    for (let index = source.indexOf('\n'); index !== -1 && index < offset; index = source.indexOf('\n', index + 1)) {
        line += 1;
    }
    return line;
}

function getFieldCoordinates(
    source: string,
    field: ScenarioYamlField | null
): Pick<
    ParsedScenarioDescriptor,
    'scenarioCodeLine' | 'scenarioCodeLineStartCharacter' | 'scenarioCodeLineEndCharacter'
> {
    if (!field) {
        return {};
    }
    const lineText = source.slice(field.lineStart, field.lineEnd);
    return {
        scenarioCodeLine: getLineNumber(source, field.lineStart),
        scenarioCodeLineStartCharacter: Math.max(0, lineText.search(/\S|$/)),
        scenarioCodeLineEndCharacter: lineText.length
    };
}

export function parseScenarioDescriptor(source: string): ParsedScenarioDescriptor {
    const yaml = ScenarioYamlDocument.parse(source);
    const isProcess = yaml.findSection('ДанныеПроцесса') !== null;
    const dataSection = isProcess ? 'ДанныеПроцесса' : 'ДанныеСценария';
    const codeField = yaml.findField(dataSection, 'Код');
    const processSteps = isProcess ? yaml.readRecords('ШагиПроцесса').map(record => {
        const type = getRecordString(record, 'ТипШага') === '1' ? 'process' : 'scenario';
        const reference: ProcessStepReference = {
            ...(getRecordString(record, 'UID') ? { uid: getRecordString(record, 'UID') } : {}),
            ...(getRecordString(record, 'Наименование') ? { name: getRecordString(record, 'Наименование') } : {}),
            type
        };
        const fields = type === 'process'
            ? { processName: 'ВложенныйПроцессНаименование', processUid: 'ВложенныйПроцессUID' }
            : { scenarioName: 'СценарийНаименование', scenarioUid: 'СценарийUID', scenarioCode: 'СценарийКод' };
        for (const [key, field] of Object.entries(fields)) {
            const value = getRecordString(record, field);
            if (value) {
                Object.assign(reference, { [key]: value });
            }
        }
        return reference;
    }) : undefined;
    const parameterDefaults = readParameterDefaults(yaml.readRecords('ПараметрыСценария'));
    const parameterTypes = Object.fromEntries(yaml.readRecords('ПараметрыСценария').flatMap(record => {
        const rawName = getRecordString(record, 'Имя');
        const name = rawName ? extractScenarioParameterNameFromText(rawName) : '';
        return name && record.fields.get('ТипПараметра') === 'Таблица' ? [[name, 'table' as const]] : [];
    }));
    const nestedScenarioNames = unique(
        isProcess ? (processSteps ?? []).map(step => step.scenarioName ?? step.processName ?? '') : yaml.readRecords('ВложенныеСценарии')
            .map(record => getRecordString(record, 'ИмяСценария'))
            .filter((value): value is string => typeof value === 'string')
    );
    const scenarioDescription = trimOptional(parseKotScenarioDescription(source));
    const scenarioCategory = trimOptional(yaml.readScalar('KOTМетаданные', 'Категория'));
    const phaseSwitcher = parsePhaseSwitcherMetadata(source);
    const header = (field: string) => trimOptional(yaml.readScalar(dataSection, field));
    const functionName = header('ФункцияСистемы'); const functionUid = header('UIDФункцияСистемы');
    const catalogValues: NonNullable<TestInfo['catalogValues']> = {};
    if (!yaml.errors.length) {
        for (const [key, field] of Object.entries({ project: 'Проект', reportLevel1: 'УровеньОтчета1', reportLevel2: 'УровеньОтчета2', responsible: 'Ответственный' })) {
            const value = header(field); if (value && !/[\r\n\0]/u.test(value)) { Object.assign(catalogValues, { [key]: value }); }
        }
        if (functionName && !/[\r\n\0]/u.test(functionName) && functionUid && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(functionUid)) {
            catalogValues.systemFunction = { name: functionName, uid: functionUid.toLocaleLowerCase() };
        }
    }

    return {
        ...(Object.keys(catalogValues).length ? { catalogValues } : {}),
        ...(isProcess ? {
            kind: 'process' as const,
            processCode: trimOptional(yaml.readScalar(dataSection, 'ПолныйКод')) ?? trimOptional(codeField?.value),
            processSteps
        } : {}),
        name: trimOptional(yaml.readScalar(dataSection, 'Имя')),
        uid: trimOptional(yaml.readScalar(dataSection, 'UID')),
        scenarioCode: trimOptional(codeField?.value),
        ...getFieldCoordinates(source, codeField),
        parameters: parameterDefaults.size > 0 ? [...parameterDefaults.keys()] : undefined,
        parameterDefaults: parameterDefaults.size > 0
            ? Object.fromEntries(parameterDefaults.entries())
            : undefined,
        ...(Object.keys(parameterTypes).length ? { parameterTypes } : {}),
        nestedScenarioNames,
        scenarioDescription,
        ...(scenarioCategory ? { scenarioCategory } : {}),
        phaseSwitcher: {
            hasTab: phaseSwitcher.hasTab,
            tabName: phaseSwitcher.tabName,
            order: phaseSwitcher.order
        }
    };
}

export function buildTestInfoFromScenarioDescriptor(
    descriptor: ParsedScenarioDescriptor,
    yamlFileUri: TestInfo['yamlFileUri'],
    relativePath: string
): TestInfo | null {
    if (!descriptor.name) {
        return null;
    }

    const result: TestInfo = {
        ...(descriptor.catalogValues ? { catalogValues: descriptor.catalogValues } : {}),
        ...(descriptor.kind === 'process' ? {
            kind: 'process',
            processCode: descriptor.processCode,
            processSteps: descriptor.processSteps?.map(step => ({ ...step }))
        } : {}),
        name: descriptor.name,
        yamlFileUri,
        relativePath,
        parameters: descriptor.parameters ? [...descriptor.parameters] : undefined,
        parameterDefaults: descriptor.parameterDefaults
            ? { ...descriptor.parameterDefaults }
            : undefined,
        ...(descriptor.parameterTypes && Object.keys(descriptor.parameterTypes).length
            ? { parameterTypes: { ...descriptor.parameterTypes } } : {}),
        nestedScenarioNames: descriptor.nestedScenarioNames
            ? [...descriptor.nestedScenarioNames]
            : undefined,
        uid: descriptor.uid,
        scenarioCode: descriptor.scenarioCode,
        scenarioDescription: descriptor.scenarioDescription,
        ...(descriptor.scenarioCategory
            ? { scenarioCategory: descriptor.scenarioCategory }
            : {}),
        scenarioCodeLine: descriptor.scenarioCodeLine,
        scenarioCodeLineStartCharacter: descriptor.scenarioCodeLineStartCharacter,
        scenarioCodeLineEndCharacter: descriptor.scenarioCodeLineEndCharacter
    };

    if (descriptor.phaseSwitcher.hasTab) {
        result.tabName = descriptor.phaseSwitcher.tabName;
        result.order = descriptor.phaseSwitcher.order ?? Infinity;
    }

    return result;
}

export function parseTestInfoFromScenarioSource(
    source: string,
    yamlFileUri: TestInfo['yamlFileUri'],
    relativePath: string
): TestInfo | null {
    return buildTestInfoFromScenarioDescriptor(
        parseScenarioDescriptor(source),
        yamlFileUri,
        relativePath
    );
}
