#!/usr/bin/env node
// Read-only CI check. Pass authored YAML roots, excluding external compatibility fixtures.
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseDocument, isMap, isScalar } = require('yaml');

async function readYaml(file) {
    const document = parseDocument(await fs.readFile(file, 'utf8'));
    if (document.errors.length || document.warnings.length || !isMap(document.contents)) {
        throw new Error(`${file}: invalid or ambiguous YAML`);
    }
    return document;
}

async function checkTestNumbering(roots, projectRoot) {
    const errors = []; const codes = new Map(); const visited = new Set(); let definitions = 0;
    const catalog = path.join(projectRoot, '.kot', 'test-numbering.yml');
    try {
        for (const file of [path.dirname(catalog), catalog]) {
            if ((await fs.lstat(file)).isSymbolicLink()) { throw new Error(`${file}: numbering catalogs cannot use symbolic links`); }
        }
        const data = (await readYaml(catalog)).toJS(); const prefixes = new Set();
        if (data.version !== 1 || !Array.isArray(data.series) || Object.keys(data).some(key => !['version', 'series'].includes(key))) { throw new Error(`${catalog}: unsupported numbering schema`); }
        for (const entry of data.series) {
            if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['prefix', 'author', 'lastNumber'].includes(key))
                || typeof entry.prefix !== 'string' || !/^\d{6}$/.test(entry.prefix)
                || typeof entry.author !== 'string' || !entry.author.trim() || /[\r\n\0]/.test(entry.author)
                || !Number.isInteger(entry.lastNumber) || entry.lastNumber < 0 || entry.lastNumber > 999) { throw new Error(`${catalog}: invalid numbering series`); }
            if (prefixes.has(entry.prefix)) { throw new Error(`${catalog}: duplicate author prefix ${entry.prefix}`); }
            prefixes.add(entry.prefix);
        }
    } catch (error) { if (error.code !== 'ENOENT') { errors.push(error.message); } }

    async function scan(file) {
        file = path.resolve(file);
        if (visited.has(file)) { return; } visited.add(file);
        try {
            const stat = await fs.lstat(file); if (stat.isSymbolicLink()) { return; }
            if (stat.isDirectory()) {
                for (const entry of await fs.readdir(file)) {
                    if (!['.git', '.kot', 'node_modules', '.vscode', 'out'].includes(entry)) { await scan(path.join(file, entry)); }
                }
                return;
            }
            if (!/\.ya?ml$/i.test(file) || /\.kot\.ya?ml$/i.test(file)) { return; }
            const source = await readYaml(file);
            const headerName = source.has('ДанныеСценария') ? 'ДанныеСценария' : 'ДанныеПроцесса';
            const header = source.get(headerName, true);
            if (!isMap(header)) { return; }
            definitions++;
            const scalar = key => {
                const node = header.get(key, true);
                if (!node || isScalar(node) && node.value === null) { return undefined; }
                if (!isScalar(node)) { throw new Error(`Test code ${key} must be a scalar`); }
                return node.type === 'PLAIN' ? node.source : String(node.value);
            };
            const values = [scalar('Код'), ...(headerName === 'ДанныеПроцесса' ? [scalar('ПолныйКод')] : [])];
            for (const code of new Set(values.filter(value => value !== undefined && value !== null && String(value).trim()).map(value => String(value).trim().toLocaleLowerCase()))) {
                const previous = codes.get(code);
                if (previous && previous !== file) { errors.push(`Duplicate test code ${code}: ${previous}; ${file}`); }
                else { codes.set(code, file); }
            }
        } catch (error) { errors.push(`${file}: ${error.message}`); }
    }
    for (const root of roots) { await scan(root); }
    return { errors, definitions };
}

module.exports = { checkTestNumbering };
if (require.main === module) {
    const args = process.argv.slice(2); let projectRoot = process.cwd();
    const option = args.indexOf('--project-root');
    if (option >= 0) { projectRoot = args[option + 1]; args.splice(option, 2); }
    if (!projectRoot || !args.length) {
        console.error('Usage: node tools/checkTestNumbering.cjs [--project-root PROJECT] YAML_ROOT...'); process.exitCode = 2;
    } else {
        checkTestNumbering(args, path.resolve(projectRoot)).then(result => {
            for (const error of result.errors) { console.error(error); }
            console.log(`Checked ${result.definitions} scenario/process definitions.`);
            process.exitCode = result.errors.length ? 1 : 0;
        }).catch(error => { console.error(error.message); process.exitCode = 1; });
    }
}
