import fs from 'node:fs';
import vm from 'node:vm';

/** Run the real shared-platform policy with controlled process/configuration adapters. */
export function loadSharedStartupPlatform(requireDependency: (name: string) => unknown): typeof import('../../src/sharedStartupPlatform') {
    const ts = require('typescript') as typeof import('typescript');
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/sharedStartupPlatform.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, { module, exports: module.exports, require: requireDependency });
    return module.exports as typeof import('../../src/sharedStartupPlatform');
}
