#!/usr/bin/env node
// Windows release helper. Always uses a new disposable IB; never opens a project/user IB.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const component = {
    name: 'client_mcp', version: '0.6.6',
    sha256: 'eaf065440a32a60eaa07c78fe7ed39c6b2c331db915e91328391af07364422fe',
    url: 'https://github.com/1c-neurofish/onec-client-mcp-devkit/releases/download/v0.6.6/client_mcp.cfe'
};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function main() {
    const [designer, sourceDt, cfe, outputDt, permissionSourceArg] = process.argv.slice(2).map(value => path.resolve(value));
    const permissionSource = permissionSourceArg || path.join(__dirname, 'startup-infobase', 'mcp-permissions', 'KOTMcpPermissions.xml');
    if (process.platform !== 'win32' || !outputDt) {
        throw new Error('Usage (Windows): node tools/buildStartupTemplate.cjs <1cv8.exe> <source.dt> <client_mcp.cfe> <new-output.dt>');
    }
    for (const file of [designer, sourceDt, cfe]) { if (!fs.statSync(file).isFile()) { throw new Error(`Not a file: ${file}`); } }
    if (fs.existsSync(outputDt) || fs.existsSync(`${outputDt}.json`)) { throw new Error('Output already exists; choose a new path.'); }
    if (hash(cfe) !== component.sha256) { throw new Error('CFE does not match the pinned official devkit release.'); }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kot-startup-template-'));
    const base = path.join(root, 'ib'); fs.mkdirSync(base);
    // Let spawn quote the complete argument for Windows, rather than embedding escaped
    // quotes which 1C's CREATEINFOBASE parser interprets differently from CommandLineToArgvW.
    if (/[;"\r\n]/u.test(base)) { throw new Error('TEMP contains unsupported connection-string delimiters.'); }
    const connection = `File=${base};`;
    let step = 0;
    function run(args) {
        const log = path.join(root, `${++step}.log`);
        console.log(`Template step ${step}: ${args[0]} ${args.find(arg => /^\/(?:RestoreIB|LoadCfg|DumpIB|DumpCfg)$/.test(arg)) || ''}`);
        const result = spawnSync(designer, [...args, '/Out', log], { shell: false, windowsHide: true,
            stdio: 'inherit', timeout: 10 * 60 * 1000 });
        if (result.error || result.status !== 0) {
            if (fs.existsSync(log)) { console.error(fs.readFileSync(log, 'utf8')); }
            throw new Error(`Step ${step} failed (${result.status}). Inspect ${log}`, { cause: result.error });
        }
    }
    run(['CREATEINFOBASE', connection]);
    const common = ['DESIGNER', '/DisableStartupDialogs', '/DisableStartupMessages', '/IBConnectionString', connection];
    run([...common, '/RestoreIB', sourceDt]);
    const authenticated = [...common, '/N', 'KOTStartupService', '/P', ''];
    run([...authenticated, '/LoadCfg', cfe, '-Extension', component.name, '/UpdateDBCfg']);
    // A separate session must be able to read the installed extension before exporting the DT.
    const exported = path.join(root, 'installed.cfe');
    run([...authenticated, '/DumpCfg', exported, '-Extension', component.name]);
    if (!fs.existsSync(exported) || fs.statSync(exported).size < 1024) { throw new Error('Installed extension was not exported.'); }
    const permissionsEpf = path.join(root, 'permissions.epf');
    run([...authenticated, '/LoadExternalDataProcessorOrReportFromFiles', permissionSource, permissionsEpf]);
    const verifySettings = (connectionString, mode, resultName) => {
        const reportFile = path.join(root, resultName);
        run(['ENTERPRISE', '/DisableStartupDialogs', '/DisableStartupMessages', '/IBConnectionString', connectionString,
            '/N', 'KOTStartupService', '/P', '', '/Execute', permissionsEpf, '/C', `KOTMcpPreparation=${mode}|${reportFile}`]);
        const settings = JSON.parse(fs.readFileSync(reportFile, 'utf8').replace(/^\uFEFF/u, ''));
        if (settings.error || settings.name !== component.name || settings.version !== component.version
            || settings.safeMode !== false || settings.active !== true || typeof settings.unsafeActionProtection !== 'boolean') {
            throw new Error(`Extension settings not verified: ${JSON.stringify(settings)}. Report: ${reportFile}`);
        }
        return settings;
    };
    const settings = verifySettings(connection, 'KOTMcpConfigure', 'configured.json');
    const candidate = path.join(root, 'prepared.dt');
    run([...authenticated, '/DumpIB', candidate]);
    if (!fs.existsSync(candidate) || fs.statSync(candidate).size < 1024) { throw new Error('DT export is missing.'); }
    const restored = path.join(root, 'restored'); fs.mkdirSync(restored);
    const restoredConnection = `File=${restored};`;
    run(['CREATEINFOBASE', restoredConnection]);
    const restoredCommon = common.map(arg => arg === connection ? restoredConnection : arg);
    run([...restoredCommon, '/RestoreIB', candidate]);
    const restoredExtension = path.join(root, 'restored-client_mcp.cfe');
    run([...restoredCommon, '/N', 'KOTStartupService', '/P', '', '/DumpCfg', restoredExtension, '-Extension', component.name]);
    if (!fs.existsSync(restoredExtension) || fs.statSync(restoredExtension).size < 1024) { throw new Error('The restored DT does not contain devkit.'); }
    const restoredSettings = verifySettings(restoredConnection, 'KOTMcpVerify', 'restored-settings.json');
    if (JSON.stringify(settings) !== JSON.stringify(restoredSettings)) { throw new Error('Extension settings changed during DT restore.'); }
    fs.copyFileSync(candidate, outputDt, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(`${outputDt}.json`, JSON.stringify({ schemaVersion: 2, templateSha256: hash(outputDt), component, settings: restoredSettings }, null, 2) + '\n', { flag: 'wx' });
    console.log(`Prepared ${outputDt}\nVerification files and logs: ${root}`);
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
