const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function walk(directory) {
    return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(file) : entry.name.endsWith('.md') ? [file] : [];
    });
}
const files = ['README.md', 'CHANGELOG.md', 'THIRD_PARTY_LICENSES.md', ...walk('documentation'), ...walk('examples/kot-workshop')];
const failures = [];
const anchors = new Map();
function source(file) { return fs.readFileSync(file, 'utf8').replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```\s*$/gmu, ''); }
function slugs(file) {
    if (anchors.has(file)) { return anchors.get(file); }
    const text = source(file); const result = new Set(); const seen = new Map();
    for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gmu)) {
        const base = match[1].replace(/<[^>]+>/gu, '').toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/gu, '-');
        const count = seen.get(base) || 0; seen.set(base, count + 1); result.add(base + (count ? '-' + count : ''));
    }
    for (const match of text.matchAll(/<(?:a|h[1-6])\b[^>]*\bid=["']([^"']+)["']/gu)) { result.add(match[1]); }
    anchors.set(file, result); return result;
}
let checked = 0;
for (const file of files) {
    const text = source(path.join(root, file));
    const links = [...text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)].map(match => match[1]);
    links.push(...[...text.matchAll(/<(?:img|a)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gu)].map(match => match[1]));
    for (let target of links) {
        target = target.replace(/^<(.+)>$/u, '$1').replace(/\s+["'][^"']*["']$/u, '');
        if (/^[a-z][a-z\d+.-]*:/iu.test(target) || target.startsWith('//')) { continue; }
        checked++;
        const [filePart, fragment] = target.split('#');
        const resolved = filePart ? path.resolve(root, path.dirname(file), decodeURIComponent(filePart)) : path.join(root, file);
        if (!fs.existsSync(resolved)) { failures.push(`${file}: missing ${target}`); continue; }
        if (fragment && resolved.endsWith('.md') && !slugs(resolved).has(decodeURIComponent(fragment))) { failures.push(`${file}: missing anchor ${target}`); }
    }
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else { console.log(`Documentation verified: ${files.length} Markdown files, ${checked} local links and images, including fragment anchors.`); }
