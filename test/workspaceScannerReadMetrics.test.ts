import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { collectTreeWithConcurrencyLimit, mapWithConcurrencyLimit } from '../src/boundedConcurrency';
import { buildScenarioCatalog } from '../src/scenarioCatalog';

test('scanner overlaps 32 descriptor reads and reports read diagnostics', async () => {
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'workspaceScanner.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;

    const root = path.join(path.sep, 'scan');
    const descriptorName = 'scen.yaml';
    let activeReads = 0;
    let maxActiveReads = 0;
    let fallbackReads = 0;
    let clockMs = 0;
    const logs: string[] = [];
    const makeUri = (fsPath: string) => ({
        fsPath,
        scheme: 'file',
        toString: () => `file://${fsPath}`
    });
    const canonicalPath = (filePath: string) => {
        clockMs += 3;
        return filePath;
    };
    const realpathSync = Object.assign(canonicalPath, {
        native: canonicalPath
    });
    const fakeFs = {
        realpathSync,
        promises: {
            stat: async () => ({ isDirectory: () => true }),
            readdir: async (directory: string) => {
                if (directory === root) {
                    return Array.from({ length: 40 }, (_, index) => ({
                        name: `scenario-${index}`,
                        isDirectory: () => true,
                        isFile: () => false
                    }));
                }
                return [{ name: descriptorName, isDirectory: () => false, isFile: () => true }];
            },
            readFile: async (filePath: string) => {
                activeReads += 1;
                maxActiveReads = Math.max(maxActiveReads, activeReads);
                await new Promise(resolve => setImmediate(resolve));
                clockMs += 1;
                activeReads -= 1;
                if (path.basename(path.dirname(filePath)) === 'scenario-3') {
                    throw new Error('Use VS Code file system provider');
                }
                return path.basename(path.dirname(filePath));
            }
        }
    };
    const vscode = {
        Uri: { file: makeUri },
        workspace: {
            fs: {
                readFile: async () => {
                    fallbackReads += 1;
                    return Buffer.from('scenario-3');
                }
            }
        },
        CancellationError: class extends Error {}
    };
    const moduleObject = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(compiled, {
        module: moduleObject,
        exports: moduleObject.exports,
        Buffer,
        process,
        performance: { now: () => clockMs },
        console: { log: (message: string) => logs.push(message) },
        require: (specifier: string) => {
            switch (specifier) {
                case 'vscode': return vscode;
                case 'fs': return fakeFs;
                case 'path': return path;
                case './boundedConcurrency': return { collectTreeWithConcurrencyLimit, mapWithConcurrencyLimit };
                case './scenarioCatalog': return { buildScenarioCatalog };
                case './scenarioScanRoot': return {
                    resolveScenarioScanRootFsPath: () => root,
                    getScenarioScanRootPath: () => root
                };
                case './scenarioDescriptor': return {
                    parseTestInfoFromScenarioSource: (name: string, uri: ReturnType<typeof makeUri>, relativePath: string) => {
                        clockMs += 2;
                        return { name, yamlFileUri: uri, relativePath };
                    }
                };
                default: throw new Error(`Unexpected dependency: ${specifier}`);
            }
        }
    });

    const scan = moduleObject.exports.scanWorkspaceForScenarioCatalog as
        (uri: ReturnType<typeof makeUri>) => Promise<ReturnType<typeof buildScenarioCatalog>>;
    const catalog = await scan(makeUri(root));

    assert.equal(catalog.all.length, 40);
    assert.equal(maxActiveReads, 32);
    assert.equal(fallbackReads, 1);
    const metrics = logs[0].match(/read p50 (\d+) ms, p95 (\d+) ms, path (\d+) ms, parse (\d+) ms, fallback attempts (\d+)/);
    assert.ok(metrics);
    assert.ok(Number(metrics[1]) > 0);
    assert.ok(Number(metrics[2]) > Number(metrics[1]));
    assert.equal(Number(metrics[3]), 240);
    assert.equal(Number(metrics[4]), 80);
    assert.equal(Number(metrics[5]), 1);
});
