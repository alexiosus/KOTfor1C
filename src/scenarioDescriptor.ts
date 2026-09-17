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
import type { TestInfo } from './types';

export interface ParsedScenarioDescriptor {
    readonly name?: string;
    readonly uid?: string;
    readonly scenarioCode?: string;
    readonly scenarioCodeLine?: number;
    readonly scenarioCodeLineStartCharacter?: number;
    readonly scenarioCodeLineEndCharacter?: number;
    readonly parameters?: readonly string[];
    readonly parameterDefaults?: Readonly<Record<string, string>>;
    readonly nestedScenarioNames?: readonly string[];
    readonly scenarioDescription?: string;
    readonly phaseSwitcher: {
        readonly hasTab: boolean;
        readonly tabName?: string;
        readonly defaultState?: boolean;
        readonly order?: number;
    };
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
            normalizeScenarioCallParameterValue(getRecordString(record, 'Значение'), name)
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
    const codeField = yaml.findField('ДанныеСценария', 'Код');
    const parameterDefaults = readParameterDefaults(yaml.readRecords('ПараметрыСценария'));
    const nestedScenarioNames = unique(
        yaml.readRecords('ВложенныеСценарии')
            .map(record => getRecordString(record, 'ИмяСценария'))
            .filter((value): value is string => typeof value === 'string')
    );
    const scenarioDescription = trimOptional(parseKotScenarioDescription(source));
    const phaseSwitcher = parsePhaseSwitcherMetadata(source);

    return {
        name: trimOptional(yaml.readScalar('ДанныеСценария', 'Имя')),
        uid: trimOptional(yaml.readScalar('ДанныеСценария', 'UID')),
        scenarioCode: trimOptional(codeField?.value),
        ...getFieldCoordinates(source, codeField),
        parameters: parameterDefaults.size > 0 ? [...parameterDefaults.keys()] : undefined,
        parameterDefaults: parameterDefaults.size > 0
            ? Object.fromEntries(parameterDefaults.entries())
            : undefined,
        nestedScenarioNames,
        scenarioDescription,
        phaseSwitcher: {
            hasTab: phaseSwitcher.hasTab,
            tabName: phaseSwitcher.tabName,
            defaultState: phaseSwitcher.defaultState,
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
        name: descriptor.name,
        yamlFileUri,
        relativePath,
        parameters: descriptor.parameters ? [...descriptor.parameters] : undefined,
        parameterDefaults: descriptor.parameterDefaults
            ? { ...descriptor.parameterDefaults }
            : undefined,
        nestedScenarioNames: descriptor.nestedScenarioNames
            ? [...descriptor.nestedScenarioNames]
            : undefined,
        uid: descriptor.uid,
        scenarioCode: descriptor.scenarioCode,
        scenarioDescription: descriptor.scenarioDescription,
        scenarioCodeLine: descriptor.scenarioCodeLine,
        scenarioCodeLineStartCharacter: descriptor.scenarioCodeLineStartCharacter,
        scenarioCodeLineEndCharacter: descriptor.scenarioCodeLineEndCharacter
    };

    if (descriptor.phaseSwitcher.hasTab) {
        result.tabName = descriptor.phaseSwitcher.tabName;
        result.defaultState = descriptor.phaseSwitcher.defaultState ?? false;
        result.order = descriptor.phaseSwitcher.order ?? Infinity;
    }

    return result;
}
