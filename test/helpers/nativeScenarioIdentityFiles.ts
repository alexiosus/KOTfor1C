import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as yaml from '../../src/scenarioYamlDocument';
import * as snapshots from '../../src/scenarioNativeDocumentSnapshot';
import * as prepared from '../../src/preparedFileWrites';

/** Exercise the actual native-boundary service against a VS Code host supplied by each fixture. */
export function nativeScenarioIdentityFiles(host: unknown): any {
    const ts = require('typescript') as typeof import('typescript');
    const source = fs.readFileSync(path.join(process.cwd(), 'src/scenarioIdentityFiles.ts'), 'utf8');
    const module = { exports: {} as any };
    const dependencies: Record<string, unknown> = { vscode: host, './scenarioYamlDocument': yaml,
        './scenarioNativeDocumentSnapshot': snapshots, './preparedFileWrites': prepared };
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, Buffer, setTimeout, clearTimeout, require: (name: string) => dependencies[name] ?? require(name) });
    return module.exports;
}
