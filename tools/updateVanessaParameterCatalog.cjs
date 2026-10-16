// Read the official source checkout; no network access or BSL execution is performed.
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const [objectFile, formFile, docsFile] = process.argv.slice(2);
if (!objectFile || !formFile) {
    throw new Error('Usage: node tools/updateVanessaParameterCatalog.cjs <ObjectModule.bsl> <Form/Module.bsl> [JsonParamsRU.md]');
}
const compiled = esbuild.buildSync({ entryPoints: [path.join(root, 'src/vanessaParameterParser.ts')], bundle: true, platform: 'node', format: 'cjs', write: false });
const parser = { exports: {} };
new Function('module', 'exports', compiled.outputFiles[0].text)(parser, parser.exports);
const entries = parser.exports.parseVanessaParameterSources(fs.readFileSync(objectFile, 'utf8'), fs.readFileSync(formFile, 'utf8'), docsFile ? fs.readFileSync(docsFile, 'utf8') : '');
if (entries.length < 100) { throw new Error('Incomplete Vanessa sources: expected at least 100 settings.'); }
fs.writeFileSync(path.join(root, 'src/vanessaParameterCatalog.generated.ts'),
    '// Generated from Pr-Mex/vanessa-automation: СтруктураОбщихНастроек and ИменаКлючейОбщихНастроек.\n'
    + '// Regenerate with tools/updateVanessaParameterCatalog.cjs; do not edit by hand.\n'
    + "import type { VanessaParameterDefinition } from './vanessaParameterParser';\n"
    + 'export const VANESSA_PARAMETER_CATALOG: readonly VanessaParameterDefinition[] = ' + JSON.stringify(entries, null, 2) + ';\n');
console.log(`Generated ${entries.length} Vanessa settings.`);
