export type VanessaManagedRunResult = 'passed' | 'failed' | 'stopped' | 'unknown' | 'cancelled';
export interface VanessaManagedRunRequest {
    readonly filePath: string;
    readonly sourceText: string;
    readonly isCurrent: () => boolean;
    readonly breakpointLines?: readonly number[];
    /** Prepares this test's JSON/infobase and starts a manager without auto-execution. */
    readonly launch: (port: number) => Promise<boolean>;
}
export interface VanessaManagedRunPorts {
    start(launch: VanessaManagedRunRequest['launch']): Promise<boolean>;
    run(filePath: string, sourceText: string, isCurrent: () => boolean, breakpointLines?: readonly number[]): Promise<Exclude<VanessaManagedRunResult, 'cancelled'>>;
}

/** Never runs a test in an arbitrarily attached manager with unrelated VAParams. */
export class VanessaManagedRun {
    private busy = false;
    constructor(private readonly ports: VanessaManagedRunPorts) {}
    async run(request: VanessaManagedRunRequest): Promise<VanessaManagedRunResult> {
        if (this.busy) { throw new Error('Vanessa is busy. Wait for the current command.'); }
        const check = () => { if (!request.isCurrent()) { throw new Error('The test artifact changed. Run the test again.'); } };
        check(); this.busy = true;
        try {
            if (!await this.ports.start(async port => { check(); return request.launch(port); })) { return 'cancelled'; }
            check();
            return await this.ports.run(request.filePath, request.sourceText, request.isCurrent, request.breakpointLines);
        } finally { this.busy = false; }
    }
}
