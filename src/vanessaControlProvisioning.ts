import { buildFileInfobaseConnectionArgument } from './oneCInfobaseConnection';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/** Official v0.6.6 release asset; WebTransport is included in its common template. */
export const VANESSA_MCP_COMPONENT = Object.freeze({
    version: '0.6.6', name: 'client_mcp',
    url: 'https://github.com/1c-neurofish/onec-client-mcp-devkit/releases/download/v0.6.6/client_mcp.cfe',
    sha256: 'eaf065440a32a60eaa07c78fe7ed39c6b2c331db915e91328391af07364422fe'
});

/** Call only after a successful fresh DT restore, never to infer the contents of an existing IB. */
export async function recordBundledMcpComponents(templatePath: string, baseDirectory: string): Promise<boolean> {
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(`${templatePath}.json`, 'utf8')); }
    catch { return false; }
    if (manifest?.schemaVersion !== 2 || manifest.settings?.safeMode !== false || manifest.settings?.active !== true
        || manifest.settings?.name !== VANESSA_MCP_COMPONENT.name || manifest.settings?.version !== VANESSA_MCP_COMPONENT.version
        || typeof manifest.settings?.unsafeActionProtection !== 'boolean' || manifest.component?.name !== VANESSA_MCP_COMPONENT.name
        || manifest.component?.version !== VANESSA_MCP_COMPONENT.version
        || manifest.component?.sha256 !== VANESSA_MCP_COMPONENT.sha256) { return false; }
    const hash = createHash('sha256').update(await fs.readFile(templatePath)).digest('hex');
    if (manifest.templateSha256 !== hash) { return false; }
    await fs.writeFile(path.join(baseDirectory, '.kot-mcp-components.json'), JSON.stringify({
        schemaVersion: 2, safeMode: false, version: VANESSA_MCP_COMPONENT.version, sha256: VANESSA_MCP_COMPONENT.sha256
    }, null, 2), 'utf8');
    return true;
}

export interface McpComponentProvisioningDependencies {
    readInstalledHash(base: string): Promise<string | undefined>;
    isBusy(base: string): Promise<boolean>;
    acquireArtifact(): Promise<string>;
    install(base: string, artifact: string): Promise<void>;
    writeInstalledHash(base: string, hash: string): Promise<void>;
}

/** Separate from template/auth preparation: a concurrent compiler ensure cannot satisfy this request. */
export class McpComponentProvisioner {
    private readonly pending = new Map<string, Promise<void>>();
    constructor(private readonly dependencies: McpComponentProvisioningDependencies) {}
    async ensure(base: string): Promise<void> {
        const current = this.pending.get(base);
        if (current) { return current; }
        const work = this.prepare(base);
        this.pending.set(base, work);
        try { await work; } finally { if (this.pending.get(base) === work) { this.pending.delete(base); } }
    }
    private async prepare(base: string): Promise<void> {
        const d = this.dependencies;
        if (await d.readInstalledHash(base) === VANESSA_MCP_COMPONENT.sha256) { return; }
        if (await d.isBusy(base)) { throw new Error('Close active service infobase sessions before installing Vanessa MCP.'); }
        const artifact = await d.acquireArtifact();
        await d.install(base, artifact);
        // On-disk state is inside the IB folder, so explicit recreation removes it as well.
        await d.writeInstalledHash(base, VANESSA_MCP_COMPONENT.sha256);
    }
}

export function buildMcpExtensionInstallArgs(base: string, artifact: string,
    auth: { username: string; password: string } | null): string[] {
    return ['DESIGNER', '/DisableStartupDialogs', '/DisableStartupMessages',
        '/IBConnectionString', buildFileInfobaseConnectionArgument(base),
        ...(auth ? ['/N', auth.username, '/P', auth.password] : []),
        '/LoadCfg', artifact, '-Extension', VANESSA_MCP_COMPONENT.name, '/UpdateDBCfg'];
}
