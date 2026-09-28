import { spawn } from 'node:child_process';
import { formatProcessCommandForDisplay } from './processCommandDisplay';

export interface DirectSpawnCommand {
    executable: string;
    args: string[];
    shell: false;
}

export interface DirectProcessCancellationToken {
    readonly isCancellationRequested: boolean;
    readonly onCancellationRequested?: (listener: () => void) => { dispose(): void };
}

export interface DirectProcessResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly cancelled: boolean;
}

export interface DirectProcessOptions {
    readonly cwd?: string;
    readonly token?: DirectProcessCancellationToken;
    readonly onCommand?: (display: string) => void;
}

export function buildDirectSpawnCommand(executable: string, args: readonly string[]): DirectSpawnCommand {
    return {
        executable,
        args: [...args],
        shell: false
    };
}

export async function runDirectProcess(
    command: DirectSpawnCommand,
    options: DirectProcessOptions = {}
): Promise<DirectProcessResult> {
    if (options.token?.isCancellationRequested) {
        return { exitCode: -1, stdout: '', stderr: '', cancelled: true };
    }
    options.onCommand?.(formatProcessCommandForDisplay(command.executable, command.args));

    return new Promise<DirectProcessResult>((resolve, reject) => {
        const child = spawn(command.executable, command.args, {
            cwd: options.cwd,
            shell: false,
            windowsHide: true
        });
        let stdout = '';
        let stderr = '';
        let cancelled = false;
        let settled = false;
        child.stdout?.on('data', chunk => {
            stdout += String(chunk);
        });
        child.stderr?.on('data', chunk => {
            stderr += String(chunk);
        });
        const cancellation = options.token?.onCancellationRequested?.(() => {
            cancelled = true;
            child.kill();
        });
        child.once('error', error => {
            if (settled) {
                return;
            }
            settled = true;
            cancellation?.dispose();
            reject(error);
        });
        child.once('close', code => {
            if (settled) {
                return;
            }
            settled = true;
            cancellation?.dispose();
            resolve({
                exitCode: code ?? -1,
                stdout,
                stderr,
                cancelled: cancelled || options.token?.isCancellationRequested === true
            });
        });
    });
}
