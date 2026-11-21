import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configureCodexServer, configureClaudeServer, configureAgentClient, checkAgentSetup } from '../src/agentSetup';
import { createTestLink } from './helpers/symlinks';

const server = { command: 'node', args: ['C:\\Program Files\\KOT\\agent-mcp.cjs', '--connection', 'C:\\Test project\\connection.json'] };
async function fixture(t: test.TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-agent-setup-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    return { root, directory: path.join(root, '.vscode/kot-runtime/agent'), skill: '---\nname: kot-testing\n---\nUse KOT evidence.\n' };
}

test('Codex setup keeps existing TOML and comments and updates only its owned server', () => {
    const original = '# User comment\r\nmodel = "company-model"\r\n[mcp_servers.docs]\r\ncommand = "docs"\r\n';
    const first = configureCodexServer(original, server);
    assert.ok(first.text.startsWith(original));
    const updated = configureCodexServer(first.text, { ...server, command: 'node-new' }, first.hash);
    assert.ok(updated.text.startsWith(original));
    assert.equal((updated.text.match(/\[mcp_servers.kot\]/gu) ?? []).length, 1);
    assert.match(updated.text, /command = "node-new"/u);
    assert.equal(configureCodexServer(updated.text, { ...server, command: 'node-new' }, updated.hash).text, updated.text);
});

test('Codex refuses unrelated kot servers, malformed TOML and edited managed sections', () => {
    assert.throws(() => configureCodexServer('[mcp_servers.kot]\ncommand="other"\n', server), /different kot/u);
    assert.throws(() => configureCodexServer('model = [', server));
    const first = configureCodexServer('', server);
    assert.throws(() => configureCodexServer(first.text.replace('command = "node"', 'command = "mine"'), server, first.hash), /edited/u);
    assert.throws(() => configureCodexServer(first.text, server), /edited/u);
    assert.throws(() => configureCodexServer(first.text + 'custom = true\n', server, first.hash), /unrelated/u);
});

test('Codex reconnect preserves appended tool approvals and still protects its launch command', () => {
    for (const eol of ['\n', '\r\n']) {
        const original = '# Keep my settings' + eol + '[mcp_servers.docs]' + eol + 'command = "docs"' + eol;
        const first = configureCodexServer(original, server);
        const approvals = ['[mcp_servers.kot.tools.kot_manager]', 'approval_mode = "approve"', '',
            '[mcp_servers.kot.tools.kot_screenshot]', 'enabled = false', ''].join(eol);
        const edited = first.text.replace('# END KOT MCP', eol + approvals + '# END KOT MCP');
        assert.equal(configureCodexServer(edited, server, first.hash).text, edited);
        const next = { ...server, command: 'node-new' };
        const updated = configureCodexServer(edited, next, first.hash);
        assert.ok(updated.text.startsWith(original)); assert.ok(updated.text.includes(approvals));
        assert.equal(updated.hash, configureCodexServer(original, next).hash);
        const more = updated.text.replace('# END KOT MCP', '[mcp_servers.kot.tools.kot_project]' + eol + 'approval_mode = "approve"' + eol + '# END KOT MCP');
        assert.equal(configureCodexServer(more, next, updated.hash).text, more);
        assert.throws(() => configureCodexServer(edited, server), /edited/u);
        assert.throws(() => configureCodexServer(edited.replace('command = "node"', 'command = "mine"'), server, first.hash), /edited/u);
        assert.throws(() => configureCodexServer(edited.replace('--connection', '--other'), server, first.hash), /edited/u);
        assert.throws(() => configureCodexServer(edited.replace('# END KOT MCP', '[mcp_servers.foreign]' + eol + 'command = "foreign"' + eol + '# END KOT MCP'), server, first.hash), /outside KOT/u);
        assert.throws(() => configureCodexServer(edited.replace('# END KOT MCP', '[[mcp_servers.kot.extra]]' + eol + 'value = "keep"' + eol + '# END KOT MCP'), server, first.hash), /prepare/u);
    }
});

test('Claude preserves other servers and root fields and refuses a foreign or edited kot entry', () => {
    const first = configureClaudeServer('{"custom":true,"mcpServers":{"docs":{"command":"docs"}}}', server);
    const updated = configureClaudeServer(first.text, { ...server, command: 'node-new' }, first.hash);
    const parsed = JSON.parse(updated.text);
    assert.equal(parsed.custom, true); assert.equal(parsed.mcpServers.docs.command, 'docs');
    assert.equal(parsed.mcpServers.kot.type, 'stdio'); assert.equal(parsed.mcpServers.kot.command, 'node-new');
    assert.throws(() => configureClaudeServer(first.text, server), /different or edited/u);
    assert.throws(() => configureClaudeServer(first.text.replace('"node"', '"mine"'), server, first.hash), /different or edited/u);
    for (const text of ['[]', '{"mcpServers":[]}', '{bad']) { assert.throws(() => configureClaudeServer(text, server)); }
});

for (const client of ['codex', 'claude'] as const) {
    test(`${client} project setup installs the skill, is repeatable and upgrades its own files`, async t => {
        const h = await fixture(t);
        const first = await configureAgentClient(h.root, h.directory, client, server, h.skill);
        assert.equal(first.changed.length, 2);
        assert.equal(await fs.readFile(first.skillPath, 'utf8'), h.skill);
        assert.deepEqual((await configureAgentClient(h.root, h.directory, client, server, h.skill)).changed, []);
        const updated = await configureAgentClient(h.root, h.directory, client, { ...server, command: 'node-new' }, h.skill + 'Updated.\n');
        assert.equal(updated.changed.length, 2);
        assert.match(await fs.readFile(updated.configPath, 'utf8'), /node-new/u);
        assert.ok((await fs.readdir(path.join(h.directory, 'setup-backups'))).length > 0);
    });
}

test('Codex project setup upgrades a legacy connection after tool approvals were added', async t => {
    const h = await fixture(t);
    const first = await configureAgentClient(h.root, h.directory, 'codex', server, h.skill);
    const approvals = '\n[mcp_servers.kot.tools.kot_environment]\napproval_mode = "approve"\n';
    const before = (await fs.readFile(first.configPath, 'utf8')).replace('# END KOT MCP', approvals + '# END KOT MCP');
    await fs.writeFile(first.configPath, before);
    const updatedSkill = h.skill + 'Updated.\n';
    const updated = await configureAgentClient(h.root, h.directory, 'codex', server, updatedSkill);
    assert.deepEqual(updated.changed, ['.agents/skills/kot-testing/SKILL.md']);
    assert.equal(await fs.readFile(first.configPath, 'utf8'), before);
    assert.equal(await fs.readFile(first.skillPath, 'utf8'), updatedSkill);
    assert.deepEqual((await configureAgentClient(h.root, h.directory, 'codex', server, updatedSkill)).changed, []);
});

test('a customized skill is preserved and prevents any config write', async t => {
    const h = await fixture(t); const skill = path.join(h.root, '.agents/skills/kot-testing/SKILL.md');
    await fs.mkdir(path.dirname(skill), { recursive: true }); await fs.writeFile(skill, 'My custom skill');
    await assert.rejects(configureAgentClient(h.root, h.directory, 'codex', server, h.skill), /skill was edited/u);
    assert.equal(await fs.readFile(skill, 'utf8'), 'My custom skill');
    await assert.rejects(fs.stat(path.join(h.root, '.codex/config.toml')), { code: 'ENOENT' });
});

test('a linked config directory cannot redirect setup outside the project', async t => {
    const h = await fixture(t); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-agent-external-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    if (!await createTestLink(t, outside, path.join(h.root, '.codex'))) { return; }
    await assert.rejects(configureAgentClient(h.root, h.directory, 'codex', server, h.skill), /linked/u);
    assert.deepEqual(await fs.readdir(outside), []);
});

test('failed publication restores existing settings and removes only its new skill', async t => {
    const h = await fixture(t); const config = path.join(h.root, '.codex/config.toml');
    await fs.mkdir(path.dirname(config)); await fs.writeFile(config, '# Keep\nmodel = "mine"\n');
    const io = require('node:fs/promises') as typeof fs; const rename = io.rename;
    io.rename = async (from, to) => {
        if (String(to) === path.join(h.directory, 'setup-codex.json')) { throw new Error('State write failed'); }
        return rename(from, to);
    };
    try { await assert.rejects(configureAgentClient(h.root, h.directory, 'codex', server, h.skill), /State write failed/u); }
    finally { io.rename = rename; }
    assert.equal(await fs.readFile(config, 'utf8'), '# Keep\nmodel = "mine"\n');
    await assert.rejects(fs.stat(path.join(h.root, '.agents/skills/kot-testing/SKILL.md')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(h.directory, 'setup.lock')), { code: 'ENOENT' });
});

test('a concurrent edit survives refused publication', async t => {
    const h = await fixture(t); const config = path.join(h.root, '.codex/config.toml');
    await fs.mkdir(path.dirname(config)); await fs.writeFile(config, 'model = "before"\n');
    const io = require('node:fs/promises') as typeof fs; const write = io.writeFile;
    io.writeFile = async (file, data, options) => {
        await write(file, data, options);
        if (String(file).startsWith(config + '.')) { await write(config, 'model = "external edit"\n'); }
    };
    try { await assert.rejects(configureAgentClient(h.root, h.directory, 'codex', server, h.skill), /files changed/u); }
    finally { io.writeFile = write; }
    assert.equal(await fs.readFile(config, 'utf8'), 'model = "external edit"\n');
});

test('missing Node produces an actionable setup error', async t => {
    const h = await fixture(t);
    await assert.rejects(checkAgentSetup({ command: path.join(h.root, 'missing-node'), args: [] }, h.root), /Install Node.js 20/u);
});
