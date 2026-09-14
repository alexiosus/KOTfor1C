import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseDocument } from 'yaml';

const scenarioTopLevelKeys = new Set([
    'ТипФайла',
    'ДанныеСценария',
    'ДанныеТеста',
    'KOTМетаданные',
    'ПараметрыСценария',
    'ВложенныеСценарии',
    'ТекстСценария'
]);

function maskScenarioStructure(source) {
    const characters = source.split('');
    const linePattern = /([^\r\n]*)(\r\n|\r|\n|$)/g;
    let currentTopLevelKey = '';
    let maskFreeFormBody = false;
    let match;

    while ((match = linePattern.exec(source)) !== null) {
        const line = match[1];
        if (line.length === 0 && match[2].length === 0) {
            break;
        }

        const lineStart = match.index;
        const lineWithoutBom = line.replace(/^\uFEFF/, '');
        const topLevelMatch = lineWithoutBom.match(/^([^\s#][^:]*):/);
        const candidateTopLevelKey = topLevelMatch?.[1]?.trim() || '';
        const topLevelKey = scenarioTopLevelKeys.has(candidateTopLevelKey)
            ? candidateTopLevelKey
            : null;

        if (maskFreeFormBody && topLevelKey) {
            maskFreeFormBody = false;
        }
        if (maskFreeFormBody) {
            characters.fill(' ', lineStart, lineStart + line.length);
            continue;
        }
        if (topLevelKey) {
            currentTopLevelKey = topLevelKey;
        }
        if (/^\s*#/.test(lineWithoutBom)) {
            continue;
        }

        const colonOffset = line.indexOf(':');
        if (colonOffset === -1) {
            continue;
        }
        let valueOffset = colonOffset + 1;
        while (valueOffset < line.length && (line[valueOffset] === ' ' || line[valueOffset] === '\t')) {
            valueOffset += 1;
        }

        const rawValue = line.slice(valueOffset);
        const isBlockScalar = /^[|>][0-9+-]*(?:\s+#.*)?$/.test(rawValue.trim());
        if (isBlockScalar && (
            currentTopLevelKey === 'ТекстСценария'
            || (currentTopLevelKey === 'KOTМетаданные' && /^\s+Описание:/.test(lineWithoutBom))
        )) {
            maskFreeFormBody = true;
        } else if (valueOffset < line.length && line[valueOffset] !== '#' && !isBlockScalar) {
            characters.fill('x', lineStart + valueOffset, lineStart + line.length);
        }
    }

    return characters.join('');
}

async function collectScenarioFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];

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

const corpusDirectory = process.argv[2];
if (!corpusDirectory) {
    console.error('Usage: npm run verify:yaml-corpus -- <scenario-directory>');
    process.exitCode = 2;
} else {
    const absoluteCorpusDirectory = path.resolve(corpusDirectory);
    const scenarioFiles = (await collectScenarioFiles(absoluteCorpusDirectory)).sort();
    const parserErrors = [];
    let warningCount = 0;

    for (const filePath of scenarioFiles) {
        const source = await readFile(filePath, 'utf8');
        const document = parseDocument(maskScenarioStructure(source), {
            prettyErrors: false,
            uniqueKeys: false
        });
        warningCount += document.warnings.length;
        for (const error of document.errors) {
            parserErrors.push(`${path.relative(absoluteCorpusDirectory, filePath)}: ${error.message}`);
        }
    }

    console.log(`Scenario YAML files: ${scenarioFiles.length}`);
    console.log(`Parser errors: ${parserErrors.length}`);
    console.log(`Parser warnings: ${warningCount}`);
    for (const parserError of parserErrors) {
        console.error(parserError);
    }

    if (parserErrors.length > 0) {
        process.exitCode = 1;
    }
}
