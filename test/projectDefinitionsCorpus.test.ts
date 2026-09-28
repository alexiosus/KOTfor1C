import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parseUserStepSource } from '../src/bslStepSourceParser';
import { parseExportScenarios } from '../src/exportScenarioParser';

const ignoredDirectories = new Set(['.git', 'node_modules', '.vscode-test', 'build', 'dist', 'out']);

async function discoverSources(root: string): Promise<string[]> {
    const result: string[] = [];
    const pending = [root];
    while (pending.length > 0) {
        const directory = pending.pop()!;
        const entries = await fs.promises.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory() && !ignoredDirectories.has(entry.name.toLocaleLowerCase())) {
                pending.push(target);
            } else if (entry.isFile() && ['.feature', '.bsl'].includes(path.extname(entry.name).toLocaleLowerCase())) {
                result.push(target);
            }
        }
    }
    return result.sort((left, right) => left.localeCompare(right));
}

async function verifyCorpus(root: string, diagnostic: (message: string) => void): Promise<void> {
    const absoluteRoot = path.resolve(root);
    const rootStat = await fs.promises.stat(absoluteRoot);
    assert.equal(rootStat.isDirectory(), true, `Corpus is not a directory: ${absoluteRoot}`);
    const files = await discoverSources(absoluteRoot);
    let definitionCount = 0;
    let warningCount = 0;
    const failures: string[] = [];

    for (const filePath of files) {
        try {
            const source = await fs.promises.readFile(filePath, 'utf8');
            const common = {
                sourceUri: pathToFileURL(filePath).href,
                workspaceFolderUri: pathToFileURL(absoluteRoot).href,
                profileId: 'corpus-smoke-test',
                libraryRootUri: pathToFileURL(absoluteRoot).href,
                sourceLabel: path.basename(absoluteRoot)
            };
            const parsed = path.extname(filePath).toLocaleLowerCase() === '.feature'
                ? parseExportScenarios(source, { ...common, defaultLanguage: 'en' })
                : parseUserStepSource(source, common);
            definitionCount += parsed.definitions.length;
            warningCount += parsed.warnings.length;
        } catch (error) {
            failures.push(`${filePath}: ${String(error)}`);
        }
    }

    diagnostic(
        `Project-definition corpus ${absoluteRoot}: ${files.length} files, `
        + `${definitionCount} definitions, ${warningCount} warnings.`
    );
    assert.deepEqual(failures, []);
}

for (const corpus of [
    { name: 'Vanessa corpus', environmentVariable: 'KOT_VANESSA_CORPUS' },
    { name: 'project definition corpus', environmentVariable: 'KOT_PROJECT_DEFINITION_CORPUS' }
]) {
    const root = process.env[corpus.environmentVariable];
    test(`${corpus.name} parses without crashes`, {
        skip: root ? false : `${corpus.environmentVariable} is not set`
    }, async context => {
        await verifyCorpus(root!, message => context.diagnostic(message));
    });
}
