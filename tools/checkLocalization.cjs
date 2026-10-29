const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const problems = [];
const read = file => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const tree = ts.parseJsonText(file, text);
    const keys = new Set();
    for (const property of tree.statements[0].expression.properties) {
        if (keys.has(property.name.text)) { problems.push(`${file}: duplicate key ${property.name.text}`); }
        keys.add(property.name.text);
    }
    return JSON.parse(text);
};
const dictionaries = [
    ['package.nls.json', 'package.nls.ru.json'],
    ['l10n/bundle.l10n.json', 'l10n/bundle.l10n.ru.json']
].map(([english, russian]) => {
    const en = read(english); const ru = read(russian);
    const placeholders = value => JSON.stringify((value.match(/\{\d+\}/gu) || []).sort());
    for (const key of new Set([...Object.keys(en), ...Object.keys(ru)])) {
        if (typeof en[key] !== 'string' || typeof ru[key] !== 'string' || !en[key].trim() || !ru[key].trim()) {
            problems.push(`${english} / ${russian}: missing translation ${key}`);
        } else if (placeholders(en[key]) !== placeholders(ru[key])) {
            problems.push(`${russian}: different placeholders ${key}`);
        }
    }
    return { en, ru };
});
const [manifestStrings, runtimeStrings] = dictionaries;
const checkMessage = (message, file) => {
    if (!Object.hasOwn(runtimeStrings.en, message) || !Object.hasOwn(runtimeStrings.ru, message)) {
        problems.push(`${file}: missing runtime message ${message}`);
    }
};
function visitSource(file) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = node => {
        if (ts.isCallExpression(node) && /(?:^|\.)(?:t|translate)$/u.test(node.expression.getText(source))
            && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
            checkMessage(node.arguments[0].text, `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
}
function walk(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { walk(file); }
        else if (file.endsWith('.ts')) { visitSource(file); }
    }
}
walk('src');
visitSource('media/kotWorkspace.js');
for (const message of Object.values(require('../media/scenarioPropertiesProtocol.js').DEFAULT_LABELS)) {
    checkMessage(message, 'media/scenarioPropertiesProtocol.js');
}
function visitManifest(value) {
    if (typeof value === 'string' && /^%[^%]+%$/u.test(value)) {
        const key = value.slice(1, -1);
        if (!Object.hasOwn(manifestStrings.en, key) || !Object.hasOwn(manifestStrings.ru, key)) { problems.push(`package.json: missing key ${key}`); }
    } else if (value && typeof value === 'object') { Object.values(value).forEach(visitManifest); }
}
visitManifest(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')));
if (problems.length) {
    console.error([...new Set(problems)].join('\n'));
    process.exitCode = 1;
} else {
    console.log(`Localization verified: ${Object.keys(manifestStrings.en).length} manifest strings, ${Object.keys(runtimeStrings.en).length} runtime strings; source calls, property labels and placeholders agree.`);
}
