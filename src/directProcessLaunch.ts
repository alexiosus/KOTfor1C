export interface DirectSpawnCommand {
    executable: string;
    args: string[];
    shell: false;
}

export function buildDirectSpawnCommand(executable: string, args: readonly string[]): DirectSpawnCommand {
    return {
        executable,
        args: [...args],
        shell: false
    };
}
