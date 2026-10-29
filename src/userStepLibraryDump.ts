import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildFileInfobaseConnectionArgument } from './oneCInfobaseConnection';
import type { UserStepLibraryBuildCancellationToken, UserStepLibraryBuildDependencies } from './userStepLibraryBuilder';
import { findUserStepRootXml, userStepSourceFingerprint, writeUserStepBuildState } from './userStepLibraryState';

export interface UserStepLibraryDumpRequest {
    readonly epfPath: string;
    readonly sourceDirectory: string;
}

export async function dumpUserStepLibrary(
    request: UserStepLibraryDumpRequest,
    dependencies: UserStepLibraryBuildDependencies,
    token: UserStepLibraryBuildCancellationToken
): Promise<{ readonly kind: 'cancelled' } | { readonly kind: 'success'; readonly rootXmlPath: string }> {
    if (token.isCancellationRequested) { return { kind: 'cancelled' }; }
    const existing = await fs.stat(request.sourceDirectory).catch(() => undefined);
    if (existing && (!existing.isDirectory() || (await fs.readdir(request.sourceDirectory)).length > 0)) {
        throw new Error('Source directory already exists and is not empty. Choose an empty directory.');
    }
    const binaryFingerprint = createHash('sha256').update(await fs.readFile(request.epfPath)).digest('hex');
    const platform = await dependencies.pickPlatform();
    if (!platform || token.isCancellationRequested) { return { kind: 'cancelled' }; }
    const startup = await dependencies.ensureStartupInfobase(platform.clientExePath);
    if (token.isCancellationRequested) { return { kind: 'cancelled' }; }
    const parent = path.dirname(request.sourceDirectory);
    await fs.mkdir(parent, { recursive: true });
    const temporary = await fs.mkdtemp(path.join(parent, '.kot-step-dump-'));
    const logPath = path.join(parent, `.kot-step-dump-${dependencies.now()}.log`);
    try {
        const result = await dependencies.runProcess({
            executable: dependencies.resolveDesignerPath(platform.clientExePath), cwd: parent,
            args: ['DESIGNER', '/IBConnectionString', buildFileInfobaseConnectionArgument(startup.infobaseDirectory, { trailingSemicolon: true }),
                ...(startup.authentication ? ['/N', startup.authentication.username, '/P', startup.authentication.password] : []),
                '/DumpExternalDataProcessorOrReportToFiles', temporary, request.epfPath,
                '/DisableStartupDialogs', '/DisableStartupMessages', '/Out', logPath]
        }, token);
        if (token.isCancellationRequested) { return { kind: 'cancelled' }; }
        if (result.exitCode !== 0) { throw new Error(`User-step library dump failed: ${result.stderr || result.stdout || result.exitCode}`); }
        const root = await findUserStepRootXml(temporary);
        if (!root) { throw new Error('User-step library dump produced no processor XML.'); }
        if (createHash('sha256').update(await fs.readFile(request.epfPath)).digest('hex') !== binaryFingerprint) {
            throw new Error('The EPF changed during the dump. Retry with a stable library.');
        }
        // rmdir only removes an empty destination; concurrent edits make it fail safely.
        await fs.rmdir(request.sourceDirectory).catch(error => { if (error.code !== 'ENOENT') { throw error; } });
        await fs.rename(temporary, request.sourceDirectory);
        const rootXmlPath = path.join(request.sourceDirectory, path.basename(root));
        await writeUserStepBuildState(rootXmlPath, request.epfPath, await userStepSourceFingerprint(rootXmlPath), binaryFingerprint);
        return { kind: 'success', rootXmlPath };
    } finally {
        await fs.rm(temporary, { force: true, recursive: true });
    }
}
