import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
const { parse: parseToml }: typeof import('smol-toml', { with: { 'resolution-mode': 'import' } }) = require('smol-toml');
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { agentHash } from './agentWorkspace';

export type AgentSetupClient = 'codex' | 'claude';
export interface AgentSetupServer { command: string; args: string[] }
interface SetupState { version: 1; client: AgentSetupClient; hashes: Record<string, string> }
const begin = '# BEGIN KOT MCP'; const end = '# END KOT MCP';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const toml = (text: string) => parseToml(text.replace(/^\uFEFF/u, ''), { integersAsBigInt: 'asNeeded', unsafeKeyBehaviour: 'throw' });

/** Keep the rest of the TOML byte for byte; never take ownership of an unrelated kot server. */
export function configureCodexServer(text: string, server: AgentSetupServer, previousHash?: string): { text: string; hash: string } {
    const parsed = toml(text);
    const blocks = [...text.matchAll(/^# BEGIN KOT MCP\r?\n[\s\S]*?^# END KOT MCP(?:\r?\n|$)/gmu)];
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const managed = blocks[0]?.[0];
    const toolsStart = managed?.search(/^[\t ]*\[mcp_servers\.kot\.tools(?:\.|\])/mu) ?? -1;
    const tools = toolsStart < 0 ? '' : managed!.slice(toolsStart, managed!.lastIndexOf(end));
    // Codex appends tool approval settings inside our markers; keep them outside the launch fingerprint.
    const launchBefore = tools ? managed!.slice(0, toolsStart).trimEnd() + eol + end + eol : managed;
    if (blocks.length > 1 || managed && agentHash(managed) !== previousHash && agentHash(launchBefore!) !== previousHash) { throw new Error('The KOT section in Codex settings was edited. Review it before reconnecting.'); }
    const base = blocks.length ? text.slice(0, blocks[0].index) + text.slice(blocks[0].index! + blocks[0][0].length) : text;
    const remaining = toml(base);
    if (record(remaining.mcp_servers) && Object.hasOwn(remaining.mcp_servers, 'kot')) { throw new Error('A different kot server already exists in Codex settings.'); }
    const launchBlock = [begin, '[mcp_servers.kot]', `command = ${JSON.stringify(server.command)}`, `args = ${JSON.stringify(server.args)}`, end, ''].join(eol);
    const block = tools ? launchBlock.slice(0, launchBlock.lastIndexOf(end)) + eol + tools + end + eol : launchBlock;
    const updated = base + (base && !base.endsWith('\n') ? eol : '') + block;
    const after = toml(updated);
    const expected = tools && record(parsed.mcp_servers) && record(parsed.mcp_servers.kot) ? { ...server, tools: parsed.mcp_servers.kot.tools } : server;
    if (!record(after.mcp_servers) || !record(after.mcp_servers.kot) || !isDeepStrictEqual({ ...after.mcp_servers.kot }, expected)) { throw new Error('Could not prepare Codex MCP settings.'); }
    delete after.mcp_servers.kot;
    if (!Object.hasOwn(remaining, 'mcp_servers') && !Object.keys(after.mcp_servers).length) { delete after.mcp_servers; }
    if (!isDeepStrictEqual(after, remaining)) { throw new Error('Codex settings outside KOT would change.'); }
    if (blocks.length) {
        if (!record(parsed.mcp_servers)) { throw new Error('Invalid managed Codex settings.'); }
        delete parsed.mcp_servers.kot;
        if (!Object.hasOwn(remaining, 'mcp_servers') && !Object.keys(parsed.mcp_servers).length) { delete parsed.mcp_servers; }
        if (!isDeepStrictEqual(parsed, remaining)) { throw new Error('The KOT section contains unrelated Codex settings.'); }
    }
    return { text: updated, hash: agentHash(launchBlock) };
}

export function configureClaudeServer(text: string | undefined, server: AgentSetupServer, previousHash?: string): { text: string; hash: string } {
    const config: unknown = text === undefined ? {} : JSON.parse(text.replace(/^\uFEFF/u, ''));
    if (!record(config) || config.mcpServers !== undefined && !record(config.mcpServers)) { throw new Error('Invalid Claude Code MCP settings.'); }
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    if (servers && Object.hasOwn(servers, 'kot') && agentHash(JSON.stringify(servers.kot)) !== previousHash) { throw new Error('A different or edited kot server already exists in Claude Code settings.'); }
    const entry = { type: 'stdio', ...server };
    return { text: JSON.stringify({ ...config, mcpServers: { ...servers, kot: entry } }, null, 2) + '\n', hash: agentHash(JSON.stringify(entry)) };
}

/** Probe the actual Node/stdio route, without requiring Vanessa or changing a test base. */
export async function checkAgentSetup(server: AgentSetupServer, root: string) {
    const { stdout } = await promisify(execFile)(server.command, ['--version'], { cwd: root, windowsHide: true, timeout: 5000, maxBuffer: 4096 })
        .catch(() => { throw new Error('Install Node.js 20 or newer, then restart VS Code.'); });
    const major = /^v(\d+)\./u.exec(stdout.trim());
    if (!major || Number(major[1]) < 20) { throw new Error('Install Node.js 20 or newer, then restart VS Code.'); }
    const client = new Client({ name: 'KOT connection setup', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
    try {
        await client.connect(new StdioClientTransport({ ...server, cwd: root, stderr: 'pipe' }), { timeout: 10000 });
        const tools = await client.listTools({}, { timeout: 10000 });
        const prompts = await client.listPrompts({}, { timeout: 10000 });
        if (!['kot_project', 'kot_run_start', 'kot_workflow'].every(name => tools.tools.some(tool => tool.name === name))
            || !prompts.prompts.some(prompt => prompt.name === 'kot_resume')) { throw new Error('The KOT connection did not advertise the required tools and workflows.'); }
        return { node: stdout.trim(), tools: tools.tools.length, workflows: prompts.prompts.length };
    } finally { await client.close(); }
}

/** Only fixed project paths are writable; links and edited managed files require manual review. */
export async function configureAgentClient(root: string, directory: string, client: AgentSetupClient, server: AgentSetupServer, skill: string) {
    root = await fs.realpath(root);
    await fs.mkdir(directory, { recursive: true });
    const lock = path.join(directory, 'setup.lock'); await fs.mkdir(lock);
    const stateFile = path.join(directory, `setup-${client}.json`);
    const optional = async (file: string) => fs.readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') { throw error; } return undefined; });
    const safe = async (relative: string) => {
        let current = root;
        for (const part of relative.split('/')) {
            current = path.join(current, part);
            const stat = await fs.lstat(current).catch(error => { if (error.code !== 'ENOENT') { throw error; } return undefined; });
            if (stat?.isSymbolicLink() || stat && current !== path.join(root, relative) && !stat.isDirectory()) { throw new Error('Agent setup cannot follow linked or invalid project paths.'); }
        }
        return current;
    };
    const replace = async (file: string, before: string | undefined, after: string) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = file + '.' + randomUUID() + '.tmp';
        try {
            await fs.writeFile(temporary, after, { flag: 'wx', mode: 0o600 });
            if (await optional(file) !== before) { throw new Error('Agent setup files changed. Retry after reviewing the changes.'); }
            await fs.rename(temporary, file);
        } finally { await fs.unlink(temporary).catch(() => undefined); }
    };
    try {
        const oldState = await optional(stateFile);
        const state: SetupState = oldState ? JSON.parse(oldState) : { version: 1, client, hashes: {} };
        if (state.version !== 1 || state.client !== client || !record(state.hashes)) { throw new Error('Invalid saved KOT connection setup.'); }
        const configPath = client === 'codex' ? '.codex/config.toml' : '.mcp.json';
        const skillPath = `${client === 'codex' ? '.agents' : '.claude'}/skills/kot-testing/SKILL.md`;
        const configBefore = await optional(await safe(configPath));
        const configured = client === 'codex' ? configureCodexServer(configBefore ?? '', server, state.hashes.server)
            : configureClaudeServer(configBefore, server, state.hashes.server);
        const skillBefore = await optional(await safe(skillPath));
        if (skillBefore !== undefined && skillBefore !== skill && agentHash(skillBefore) !== state.hashes.skill) { throw new Error('The existing kot-testing skill was edited. Keep a copy and review it before reconnecting.'); }
        const changes = [{ relative: configPath, before: configBefore, after: configured.text }, { relative: skillPath, before: skillBefore, after: skill }]
            .filter(change => change.before !== change.after);
        const backups = path.join(directory, 'setup-backups', randomUUID());
        for (const change of changes) {
            if (change.before === undefined) { continue; }
            await fs.mkdir(backups, { recursive: true });
            await fs.writeFile(path.join(backups, path.basename(change.relative)), change.before, { flag: 'wx', mode: 0o600 });
        }
        const written: typeof changes = [];
        try {
            for (const change of changes) {
                await replace(await safe(change.relative), change.before, change.after); written.push(change);
            }
            await replace(stateFile, oldState, JSON.stringify({ version: 1, client, hashes: { server: configured.hash, skill: agentHash(skill) } }, null, 2));
        } catch (error) {
            const rollbackErrors: unknown[] = [];
            for (const change of written.reverse()) {
                try {
                    const file = await safe(change.relative);
                    if (await optional(file) !== change.after) { continue; }
                    if (change.before === undefined) { await fs.unlink(file); } else { await replace(file, change.after, change.before); }
                } catch (rollbackError) { rollbackErrors.push(rollbackError); }
            }
            if (rollbackErrors.length) { throw new AggregateError([error, ...rollbackErrors], 'Agent setup failed; review the saved backups before retrying.'); }
            throw error;
        }
        return { configPath: path.join(root, configPath), skillPath: path.join(root, skillPath), changed: changes.map(change => change.relative) };
    } finally { await fs.rmdir(lock); }
}
