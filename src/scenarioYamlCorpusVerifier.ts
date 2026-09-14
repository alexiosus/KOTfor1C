import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
    ScenarioYamlDocument,
    type SourceRange
} from './scenarioYamlDocument';

const SCENARIO_SECTIONS = [
    'ТипФайла',
    'ДанныеСценария',
    'ДанныеТеста',
    'KOTМетаданные',
    'ПараметрыСценария',
    'ВложенныеСценарии',
    'ТекстСценария'
] as const;

const RECORD_SECTIONS = ['ПараметрыСценария', 'ВложенныеСценарии'] as const;

export interface ScenarioYamlValidationResult {
    errors: string[];
    warnings: string[];
    sectionCount: number;
    recordCount: number;
}

export interface ScenarioYamlCorpusResult {
    fileCount: number;
    errorCount: number;
    warningCount: number;
    errors: string[];
    warnings: string[];
}

function validateRange(
    label: string,
    range: SourceRange,
    sourceLength: number,
    errors: string[]
): void {
    if (!Number.isInteger(range.start)
        || !Number.isInteger(range.end)
        || range.start < 0
        || range.end < range.start
        || range.end > sourceLength) {
        errors.push(`${label} has an invalid source range ${range.start}:${range.end}`);
    }
}

export function validateScenarioYamlSource(source: string): ScenarioYamlValidationResult {
    const document = ScenarioYamlDocument.parse(source);
    const errors = document.errors.map(error => `YAML parser: ${error}`);
    const warnings = document.warnings.map(warning => `YAML parser: ${warning}`);
    let sectionCount = 0;
    let recordCount = 0;

    if (errors.length > 0) {
        return { errors, warnings, sectionCount, recordCount };
    }

    for (const sectionName of SCENARIO_SECTIONS) {
        const section = document.findSection(sectionName);
        if (!section) {
            continue;
        }
        sectionCount += 1;
        validateRange(`${sectionName} pair`, section.pairRange, source.length, errors);
        validateRange(`${sectionName} body`, section.bodyRange, source.length, errors);
        if (section.valueRange) {
            validateRange(`${sectionName} value`, section.valueRange, source.length, errors);
        }
    }

    for (const sectionName of RECORD_SECTIONS) {
        for (const record of document.readRecords(sectionName)) {
            recordCount += 1;
            validateRange(`${sectionName}.${record.key}`, record.range, source.length, errors);
            for (const fieldName of record.fields.keys()) {
                if (!fieldName.trim()) {
                    errors.push(`${sectionName}.${record.key} has an empty field name`);
                }
            }
        }
    }

    return { errors, warnings, sectionCount, recordCount };
}

async function collectScenarioFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectScenarioFiles(entryPath));
        } else if (entry.isFile() && entry.name === 'scen.yaml') {
            files.push(entryPath);
        }
    }

    return files;
}

export async function verifyScenarioYamlCorpus(directory: string): Promise<ScenarioYamlCorpusResult> {
    const absoluteDirectory = path.resolve(directory);
    const scenarioFiles = (await collectScenarioFiles(absoluteDirectory)).sort();
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const filePath of scenarioFiles) {
        const source = await readFile(filePath, 'utf8');
        const result = validateScenarioYamlSource(source);
        const relativePath = path.relative(absoluteDirectory, filePath);
        errors.push(...result.errors.map(error => `${relativePath}: ${error}`));
        warnings.push(...result.warnings.map(warning => `${relativePath}: ${warning}`));
    }

    return {
        fileCount: scenarioFiles.length,
        errorCount: errors.length,
        warningCount: warnings.length,
        errors,
        warnings
    };
}

async function runCli(): Promise<void> {
    const corpusDirectory = process.argv[2];
    if (!corpusDirectory) {
        console.error('Usage: npm run verify:yaml-corpus -- <scenario-directory>');
        process.exitCode = 2;
        return;
    }

    const result = await verifyScenarioYamlCorpus(corpusDirectory);
    console.log(`Scenario YAML files: ${result.fileCount}`);
    console.log(`Parser errors: ${result.errorCount}`);
    console.log(`Parser warnings: ${result.warningCount}`);
    result.errors.forEach(error => console.error(error));
    result.warnings.forEach(warning => console.warn(warning));
    if (result.errorCount > 0) {
        process.exitCode = 1;
    }
}

if (path.basename(process.argv[1] ?? '') === 'scenarioYamlCorpusVerifier.js') {
    void runCli().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
