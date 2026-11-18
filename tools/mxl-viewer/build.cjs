// node tools/mxl-viewer/build.cjs <path-to-1cv8.exe>
// Compiles in a disposable build IB; never connects to a user's working IB.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
async function main() {
    const executable = process.argv[2];
    if (!executable || !path.isAbsolute(executable)) throw new Error('Pass an absolute path to 1cv8.exe');
    const root = path.resolve(__dirname, '../..');
    const temporary = path.join(root, 'artifacts/mxl-viewer-build'); await fs.mkdir(temporary, { recursive: true });
    const base = await fs.mkdtemp(path.join(temporary, 'ib-'));
    const options = { windowsHide: true, timeout: 120000 };
    await run(executable, ['CREATEINFOBASE', `File=${base};`, '/Out', path.join(base, 'create.log')], options);
    const destination = path.join(root, 'res/mxl/KOTMxlViewer.epf'); await fs.mkdir(path.dirname(destination), { recursive: true });
    await run(executable, ['DESIGNER', '/F', base, '/LoadExternalDataProcessorOrReportFromFiles', path.join(__dirname, 'KOTMxlViewer.xml'), destination,
        '/DisableStartupDialogs', '/DisableStartupMessages', '/Out', path.join(base, 'compile.log')], options);
    if (!(await fs.stat(destination)).size) throw new Error('The MXL viewer EPF is empty');
    console.log('Built res/mxl/KOTMxlViewer.epf');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
