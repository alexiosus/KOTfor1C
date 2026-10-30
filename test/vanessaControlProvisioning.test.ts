import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { McpComponentProvisioner, VANESSA_MCP_COMPONENT, buildMcpExtensionInstallArgs, recordBundledMcpComponents } from '../src/vanessaControlProvisioning';

function setup() {
    let saved: string | undefined; const events: string[] = []; let busy = false; let fail = false;
    const provisioner = new McpComponentProvisioner({
        readInstalledHash: async () => saved, isBusy: async () => busy,
        acquireArtifact: async () => { events.push('download'); return '/cache/client_mcp.cfe'; },
        install: async () => { events.push('install'); if (fail) { throw new Error('locked'); } },
        writeInstalledHash: async (_base, hash) => { events.push('commit'); saved = hash; }
    });
    return { provisioner, events, setBusy: (value: boolean) => { busy = value; }, setFail: (value: boolean) => { fail = value; } };
}

test('MCP preparation coalesces concurrent requests, installs once, and reuses the pinned component', async () => {
    const { provisioner, events } = setup();
    await Promise.all([provisioner.ensure('/service/ib'), provisioner.ensure('/service/ib')]);
    assert.deepEqual(events, ['download', 'install', 'commit']);
    await provisioner.ensure('/service/ib');
    assert.deepEqual(events, ['download', 'install', 'commit']);
});

test('a failed or busy installation never records readiness and can be retried', async () => {
    const s = setup(); s.setBusy(true);
    await assert.rejects(s.provisioner.ensure('/service/ib'), /close.*session/i);
    assert.deepEqual(s.events, []);
    s.setBusy(false); s.setFail(true);
    await assert.rejects(s.provisioner.ensure('/service/ib'));
    assert.deepEqual(s.events, ['download', 'install']);
    s.setFail(false); await s.provisioner.ensure('/service/ib');
    assert.deepEqual(s.events, ['download', 'install', 'download', 'install', 'commit']);
});

test('component state belongs to the actual service base, without requiring VAExtension in test clients', async () => {
    const s = setup(); await s.provisioner.ensure('/service/ib'); await s.provisioner.ensure('/other-service/ib');
    // Dependency test below uses a per-base store as the disk adapter does.
    const installed = new Map<string, string>(); let installs = 0;
    const provisioner = new McpComponentProvisioner({
        readInstalledHash: async base => installed.get(base), isBusy: async () => false,
        acquireArtifact: async () => '/cache/client_mcp.cfe', install: async () => { installs++; },
        writeInstalledHash: async (base, hash) => { installed.set(base, hash); }
    });
    await provisioner.ensure('/first'); await provisioner.ensure('/second');
    installed.delete('/first'); await provisioner.ensure('/first');
    assert.equal(installs, 3);
    assert.equal(installed.get('/first'), VANESSA_MCP_COMPONENT.sha256);
});

test('extension installation targets only the selected service IB and never restores/recreates it', () => {
    const args = buildMcpExtensionInstallArgs('C:\\KOT Service\\ib', 'C:\\Cache\\client.cfe', { username: 'KOTStartupService', password: '' });
    assert.equal(args[0], 'DESIGNER');
    assert.equal(args[args.indexOf('/LoadCfg') + 1], 'C:\\Cache\\client.cfe');
    assert.equal(args[args.indexOf('-Extension') + 1], 'client_mcp');
    assert.ok(args.includes('/UpdateDBCfg'));
    assert.ok(!args.some(arg => /RestoreIB|CREATEINFOBASE|LoadConfigFromFiles|SafeMode/iu.test(arg)));
});

test('a fresh restore from the verified bundled DT is ready without downloading or installing devkit', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-bundled-mcp-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const template = path.join(root, 'template.dt'); const base = path.join(root, 'ib');
    await fs.mkdir(base);
    await fs.writeFile(template, 'prepared service base');
    await fs.writeFile(`${template}.json`, JSON.stringify({ schemaVersion: 2, settings: { name: 'client_mcp', version: '0.6.6', safeMode: false, active: true, unsafeActionProtection: true },
        templateSha256: createHash('sha256').update('prepared service base').digest('hex'),
        component: VANESSA_MCP_COMPONENT }));
    assert.equal(await recordBundledMcpComponents(template, base), true);
    const installed = JSON.parse(await fs.readFile(path.join(base, '.kot-mcp-components.json'), 'utf8'));
    assert.equal(installed.sha256, VANESSA_MCP_COMPONENT.sha256);
    const provisioner = new McpComponentProvisioner({
        readInstalledHash: async () => installed.sha256,
        isBusy: async () => { throw new Error('must not probe a prepared base'); },
        acquireArtifact: async () => { throw new Error('must not download'); },
        install: async () => { throw new Error('must not install'); },
        writeInstalledHash: async () => { throw new Error('must not rewrite'); }
    });
    await provisioner.ensure(base);
});

test('old, mismatched, or incomplete template manifests never declare devkit ready', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-old-template-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const template = path.join(root, 'template.dt'); const base = path.join(root, 'ib');
    await fs.mkdir(base); await fs.writeFile(template, 'legacy');
    const valid = { schemaVersion: 2, settings: { name: 'client_mcp', version: '0.6.6', safeMode: false, active: true, unsafeActionProtection: true }, templateSha256: createHash('sha256').update('legacy').digest('hex'),
        component: VANESSA_MCP_COMPONENT };
    assert.equal(await recordBundledMcpComponents(template, base), false);
    for (const manifest of [{}, { ...valid, schemaVersion: 1 }, { ...valid, settings: undefined },
        { ...valid, settings: { ...valid.settings, safeMode: true } }, { ...valid, templateSha256: 'wrong' },
        { ...valid, component: { ...valid.component, version: 'old' } },
        { ...valid, component: { ...valid.component, sha256: 'wrong' } }]) {
        await fs.writeFile(`${template}.json`, JSON.stringify(manifest));
        assert.equal(await recordBundledMcpComponents(template, base), false);
    }
    await assert.rejects(fs.access(path.join(base, '.kot-mcp-components.json')));
});

test('the distributed service DT includes the pinned devkit manifest', async t => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-release-template-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    assert.equal(await recordBundledMcpComponents(path.resolve('tools/startup-infobase/KOTStartupTemplate.dt'), base), true);
});
