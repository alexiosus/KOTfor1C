import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import type { Translator } from '../../src/localization';

/** Exercise the shipped translator with real bundles and an independently chosen VS Code language. */
export async function translatorFor(override: 'System' | 'English' | 'Русский', systemLanguage = 'en'): Promise<Translator> {
    const ts = require('typescript') as typeof import('typescript');
    const russian = JSON.parse(fs.readFileSync('l10n/bundle.l10n.ru.json', 'utf8'));
    const module = { exports: {} as typeof import('../../src/localization') };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/localization.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText, { module, exports: module.exports, Buffer, require: () => ({
        workspace: { getConfiguration: () => ({ get: () => override }), fs: { readFile: (uri: { fsPath: string }) => fs.promises.readFile(uri.fsPath) } },
        Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
        l10n: { t: (message: string, ...args: string[]) => (systemLanguage === 'ru' ? russian[message] ?? message : message)
            .replace(/\{(\d+)\}/gu, (match: string, index: string) => args[Number(index)] ?? match) }
    }) });
    return module.exports.getTranslator({ fsPath: process.cwd() } as any);
}
