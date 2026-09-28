import * as path from 'node:path';
import { buildFileInfobaseConnectionArgument } from './oneCInfobaseConnection';

export interface UserStepLibraryBuildRequest {
    readonly rootXmlPath: string;
    readonly targetEpfPath: string;
}

export interface UserStepLibraryBuildCancellationToken {
    readonly isCancellationRequested: boolean;
}

export interface UserStepLibraryBuildCommand {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
}

export interface UserStepLibraryBuildDependencies {
    readonly pickPlatform: () => Promise<{ readonly clientExePath: string } | null>;
    readonly ensureStartupInfobase: (clientExePath: string) => Promise<{
        readonly infobaseDirectory: string;
        readonly authentication: { readonly username: string; readonly password: string } | null;
    }>;
    readonly runProcess: (
        command: UserStepLibraryBuildCommand,
        token: UserStepLibraryBuildCancellationToken
    ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
    readonly fileSystem: {
        mkdir(path: string, options: { recursive: true }): Promise<void>;
        stat(path: string): Promise<{ readonly size: number }>;
        rename(from: string, to: string): Promise<void>;
        rm(path: string, options: { force: true }): Promise<void>;
    };
    readonly now: () => number;
    readonly resolveDesignerPath: (clientExePath: string) => string;
    readonly log?: (message: string) => void;
}

export type UserStepBuildResult =
    | { readonly kind: 'cancelled' }
    | {
        readonly kind: 'success';
        readonly targetEpfPath: string;
        readonly logPath: string;
    };

function cancelled(): UserStepBuildResult {
    return Object.freeze({ kind: 'cancelled' as const });
}

export async function buildUserStepLibrary(
    request: UserStepLibraryBuildRequest,
    dependencies: UserStepLibraryBuildDependencies,
    token: UserStepLibraryBuildCancellationToken
): Promise<UserStepBuildResult> {
    if (token.isCancellationRequested) {
        return cancelled();
    }

    const platform = await dependencies.pickPlatform();
    if (!platform || token.isCancellationRequested) {
        return cancelled();
    }
    const startup = await dependencies.ensureStartupInfobase(platform.clientExePath);
    if (token.isCancellationRequested) {
        return cancelled();
    }

    const targetDirectory = path.dirname(request.targetEpfPath);
    const baseName = path.basename(request.targetEpfPath, path.extname(request.targetEpfPath));
    const buildId = dependencies.now();
    const temporaryEpfPath = path.join(targetDirectory, `.${baseName}.kot-build-${buildId}.epf`);
    const logPath = path.join(targetDirectory, `.${baseName}.kot-build-${buildId}.log`);
    await dependencies.fileSystem.mkdir(targetDirectory, { recursive: true });
    await dependencies.fileSystem.rm(temporaryEpfPath, { force: true });

    const authenticationArgs = startup.authentication
        ? ['/N', startup.authentication.username, '/P', startup.authentication.password]
        : [];
    const args = [
        'DESIGNER',
        '/IBConnectionString',
        buildFileInfobaseConnectionArgument(startup.infobaseDirectory, { trailingSemicolon: true }),
        ...authenticationArgs,
        '/LoadExternalDataProcessorOrReportFromFiles',
        request.rootXmlPath,
        temporaryEpfPath,
        '/DisableStartupDialogs',
        '/DisableStartupMessages',
        '/Out',
        logPath
    ];
    const command = Object.freeze({
        executable: dependencies.resolveDesignerPath(platform.clientExePath),
        args: Object.freeze(args),
        cwd: path.dirname(request.rootXmlPath)
    });
    dependencies.log?.(`Building user-step library: ${request.targetEpfPath}`);

    try {
        const processResult = await dependencies.runProcess(command, token);
        if (token.isCancellationRequested) {
            await dependencies.fileSystem.rm(temporaryEpfPath, { force: true });
            return cancelled();
        }
        if (processResult.exitCode !== 0) {
            const details = processResult.stderr.trim() || processResult.stdout.trim();
            throw new Error(`User-step library build failed with exit code ${processResult.exitCode}${
                details ? `: ${details}` : ''
            }.`);
        }
        const output = await dependencies.fileSystem.stat(temporaryEpfPath).catch(() => null);
        if (!output || output.size <= 0) {
            throw new Error('User-step library build produced no valid output EPF.');
        }
        await dependencies.fileSystem.rename(temporaryEpfPath, request.targetEpfPath);
        return Object.freeze({
            kind: 'success' as const,
            targetEpfPath: request.targetEpfPath,
            logPath
        });
    } catch (error) {
        await dependencies.fileSystem.rm(temporaryEpfPath, { force: true });
        throw error;
    }
}
