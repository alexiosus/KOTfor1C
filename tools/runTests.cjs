const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'out', 'test');
const files = fs.readdirSync(directory).filter(file => file.endsWith('.test.js')).sort()
    .map(file => path.join('out', 'test', file));
if (!files.length) {
    throw new Error('No compiled tests found. Run npm run compile-tests first.');
}
// Windows shells and Node 20 do not expand the old out/test/*.test.js argument.
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
    cwd: root, stdio: 'inherit', shell: false, windowsHide: true
});
if (result.error) { console.error(result.error.message); }
process.exitCode = result.status ?? 1;
