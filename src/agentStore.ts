import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentHash } from './agentWorkspace';

export type AgentStatus = 'queued' | 'running' | 'awaiting_agent' | 'awaiting_approval' | 'passed' | 'failed' | 'stopped' | 'cancelled' | 'unknown' | 'completed';
export interface AgentEvent { readonly time: string; readonly kind: string; readonly data: unknown }
export interface AgentArtifact { readonly id: string; readonly name: string; readonly file: string; readonly sha256: string; readonly size: number }
export interface AgentRecord {
    readonly schemaVersion: 1; readonly id: string; readonly kind: 'run' | 'story' | 'review' | 'generation' | 'incident' | 'repair' | 'environment';
    readonly createdAt: string; updatedAt: string; status: AgentStatus; readonly requestKey?: string;
    request: Record<string, unknown>; events: AgentEvent[]; artifacts: AgentArtifact[];
    result?: unknown;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const validId = (id: string) => /^[a-z0-9-]{1,80}$/u.test(id);

/** One durable record per operation. All writes are serialized and published by rename. */
export class AgentStore {
    private tail: Promise<unknown> = Promise.resolve();
    constructor(readonly directory: string, private readonly publish: typeof fs.rename = fs.rename) {}
    private serial<T>(work: () => Promise<T>): Promise<T> {
        const operation = this.tail.then(work); this.tail = operation.catch(() => undefined); return operation;
    }
    private file(id: string): string {
        if (!validId(id)) { throw new Error('Invalid operation identifier.'); }
        return path.join(this.directory, id, 'operation.json');
    }
    private async write(record: AgentRecord): Promise<void> {
        const file = this.file(record.id); await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = file + '.' + randomUUID() + '.tmp';
        await fs.writeFile(temporary, JSON.stringify(record, null, 2), { flag: 'wx' });
        try {
            for (let attempt = 0; ; attempt++) {
                try { await this.publish(temporary, file); return; }
                catch (error) {
                    if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) { throw error; }
                    await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
                }
            }
        } catch (error) {
            await fs.rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
    }
    private async base(id: string): Promise<AgentRecord> {
        const record = JSON.parse(await fs.readFile(this.file(id), 'utf8')) as AgentRecord;
        if (record.schemaVersion !== 1 || record.id !== id || !Array.isArray(record.events) || !Array.isArray(record.artifacts)) {
            throw new Error('Invalid operation record.');
        }
        return record;
    }
    get(id: string): Promise<AgentRecord> { return this.serial(() => this.readRecord(id)); }
    private async readRecord(id: string): Promise<AgentRecord> {
        const record = await this.base(id);
        try {
            const text = await fs.readFile(path.join(path.dirname(this.file(id)), 'events.ndjson'), 'utf8');
            const lines = text.split('\n');
            for (let index = 0; index < lines.length; index++) {
                if (!lines[index]) { continue; }
                try { record.events.push(JSON.parse(lines[index]) as AgentEvent); }
                catch { if (index !== lines.length - 1) { throw new Error('Corrupted operation event history.'); } }
            }
            record.events.sort((left, right) => left.time.localeCompare(right.time));
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        return record;
    }
    list(limit = 40): Promise<AgentRecord[]> { return this.serial(() => this.readRecords(limit)); }
    private async readRecords(limit: number): Promise<AgentRecord[]> {
        await fs.mkdir(this.directory, { recursive: true });
        const entries = await fs.readdir(this.directory, { withFileTypes: true });
        const records: AgentRecord[] = [];
        for (const entry of entries) {
            if (entry.isDirectory() && validId(entry.name)) { try { records.push(await this.base(entry.name)); } catch { /* Incomplete directories are not operations. */ } }
        }
        return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    }
    async create(kind: AgentRecord['kind'], request: Record<string, unknown>, requestKey?: string): Promise<{ record: AgentRecord; existing: boolean }> {
        return this.serial(async () => {
            if (requestKey) {
                const records = await this.readRecords(100_000);
                const existing = records.find(item => item.kind === kind && item.requestKey === requestKey);
                if (existing) {
                    if (JSON.stringify(existing.request) !== JSON.stringify(request)) { throw new Error('This request key belongs to a different request.'); }
                    return { record: existing, existing: true };
                }
            }
            const now = new Date().toISOString();
            const record: AgentRecord = { schemaVersion: 1, id: randomUUID(), kind, createdAt: now, updatedAt: now,
                status: 'queued', request: clone(request), events: [], artifacts: [], ...(requestKey ? { requestKey } : {}) };
            await this.write(record); return { record, existing: false };
        });
    }
    async update(id: string, change: (record: AgentRecord) => void): Promise<AgentRecord> {
        return this.serial(async () => {
            const record = await this.base(id); change(record); record.updatedAt = new Date().toISOString();
            await this.write(record); return this.readRecord(id);
        });
    }
    async event(id: string, kind: string, data: unknown): Promise<void> {
        await this.serial(async () => {
            await this.base(id);
            const file = path.join(path.dirname(this.file(id)), 'events.ndjson');
            const event: AgentEvent = { time: new Date().toISOString(), kind, data: clone(data) };
            await fs.appendFile(file, JSON.stringify(event) + '\n');
        });
    }
    async artifact(id: string, name: string, content: string | Buffer): Promise<AgentArtifact> {
        const artifactId = randomUUID(); const file = path.join(path.dirname(this.file(id)), artifactId + (Buffer.isBuffer(content) ? '.png' : '.txt'));
        await fs.writeFile(file, content, { flag: 'wx' });
        const artifact = { id: artifactId, name, file, sha256: agentHash(content), size: Buffer.byteLength(content) };
        await this.update(id, record => { record.artifacts.push(artifact); }); return artifact;
    }
    async recover(): Promise<void> {
        for (const record of await this.list(100_000)) {
            const eventFile = path.join(path.dirname(this.file(record.id)), 'events.ndjson');
            try {
                const events = await fs.readFile(eventFile);
                if (events.length && events[events.length - 1] !== 10) { await fs.truncate(eventFile, events.lastIndexOf(10) + 1); }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
            if (record.status === 'running' || record.status === 'queued' || record.request.action === 'kot_action' && record.status === 'awaiting_agent') {
                await this.update(record.id, value => {
                    value.status = 'unknown'; value.events.push({ time: new Date().toISOString(), kind: 'host_restarted',
                        data: 'Execution must be reconciled with the live session before another run.' });
                });
            }
        }
    }
    async idle(): Promise<void> { await this.tail; }
}
