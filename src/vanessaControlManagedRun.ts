export type VanessaManagedRunResult = 'passed' | 'failed' | 'stopped' | 'unknown' | 'cancelled';
export interface VanessaManagedRunRequest {
    readonly filePath: string;
    readonly sourceText: string;
    readonly isCurrent: () => boolean;
    readonly breakpointLines?: readonly number[];
    /** Opaque identity of the authored settings and their relative-path context. Never credentials. */
    readonly configurationKey?: string;
    /** Prepares this test's JSON/infobase and starts a manager without auto-execution. */
    readonly launch: (port: number) => Promise<boolean>;
}
export interface VanessaManagedRunPorts {
    currentGeneration?(): number | undefined;
    chooseSession?(): Promise<'current' | 'configured' | 'cancelled'>;
    start(launch: VanessaManagedRunRequest['launch']): Promise<boolean>;
    run(filePath: string, sourceText: string, isCurrent: () => boolean, breakpointLines?: readonly number[]): Promise<Exclude<VanessaManagedRunResult, 'cancelled'>>;
}

/** Reuses matching launches; a different session's parameters require an explicit choice. */
export class VanessaManagedRun {
    private busy = false;
    /** Includes explicit current-settings consent; it is not evidence that VAParams was applied. */
    private accepted?: { readonly generation: number; readonly configurationKey: string };
    constructor(private readonly ports: VanessaManagedRunPorts) {}
    async run(request: VanessaManagedRunRequest): Promise<VanessaManagedRunResult> {
        if (this.busy) { throw new Error('Vanessa is busy. Wait for the current command.'); }
        const check = () => { if (!request.isCurrent()) { throw new Error('The test artifact changed. Run the test again.'); } };
        check(); this.busy = true;
        try {
            const generation = this.ports.currentGeneration?.();
            let reuse = generation !== undefined && request.configurationKey !== undefined
                && this.accepted?.generation === generation && this.accepted.configurationKey === request.configurationKey;
            if (generation !== undefined && !reuse && this.ports.chooseSession) {
                const choice = await this.ports.chooseSession();
                check();
                if (this.ports.currentGeneration?.() !== generation) { throw new Error('The Vanessa connection changed. Run the test again.'); }
                if (choice === 'cancelled') { return 'cancelled'; }
                reuse = choice === 'current';
            }
            if (!reuse && !await this.ports.start(async port => { check(); return request.launch(port); })) { return 'cancelled'; }
            check();
            const activeGeneration = this.ports.currentGeneration?.();
            if (activeGeneration !== undefined && request.configurationKey !== undefined) {
                this.accepted = { generation: activeGeneration, configurationKey: request.configurationKey };
            }
            return await this.ports.run(request.filePath, request.sourceText, request.isCurrent, request.breakpointLines);
        } finally { this.busy = false; }
    }
}
