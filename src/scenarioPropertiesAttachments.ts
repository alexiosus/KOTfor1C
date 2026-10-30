import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ScenarioFilesService, ScenarioFilesDisposable } from './scenarioFilesService';
import type { StepLibraryItem } from './stepLibraryModel';
import { parseScenarioFilesMessage } from './scenarioFilesWebviewProtocol';

type Service = Pick<ScenarioFilesService, 'listAttachmentPaths' | 'watch' | 'openExternal' | 'revealInOs' | 'deleteFile' | 'renameFile'
    | 'prepareDrop' | 'appendTransferChunk' | 'completeTransfer' | 'cancelTransfer'>;
interface Host {
    currentSourceUri(): string | undefined;
    validateSource(uri: string): Promise<boolean>;
    postMessage(value: Record<string, unknown>): Promise<unknown>;
    chooseFiles?(sourceUri: string): Promise<readonly string[] | undefined>;
    insertFileName?(name: string, stillCurrent: () => boolean): Promise<boolean>;
}
interface Scope { uri: string; item: StepLibraryItem; rootUri: string }
const commands = new Set(['openScenarioFile', 'revealScenarioFile', 'deleteScenarioFile', 'renameScenarioFile', 'prepareScenarioFileDrop',
    'appendScenarioFileChunk', 'completeScenarioFileTransfer', 'cancelScenarioFileTransfer', 'addScenarioFilesFromUris',
    'chooseScenarioFiles', 'insertScenarioFileName']);

/** The Properties view owns only its uploads; all attachment IO uses the shared service. */
export class ScenarioPropertiesAttachments {
    private scope?: Scope;
    private watch?: ScenarioFilesDisposable;
    private readonly transfers = new Map<string, Scope>();
    private disposed = false;
    private inventoryGeneration = 0;
    constructor(private readonly service: Service, private readonly host: Host) {}

    isMessage(value: unknown): boolean {
        return !!value && typeof value === 'object' && commands.has(String((value as Record<string, unknown>).command));
    }
    bindSource(uri?: string): void {
        if (this.disposed || uri === this.scope?.uri) { return; }
        this.inventoryGeneration++; this.watch?.dispose(); this.watch = undefined; this.scope = undefined;
        for (const id of this.transfers.keys()) { this.transfers.delete(id); void this.service.cancelTransfer(id); }
        if (!uri) { return; }
        try {
            const file = fileURLToPath(uri); const name = path.basename(file);
            const item: StepLibraryItem = { id: uri, definitionId: uri, familyId: uri, kind: 'nestedScenario', sourceGroup: 'nested',
                template: name, displayText: name, categoryPath: [], parameters: [], sourceLabel: name, navigable: true, insertable: false,
                capturedLocation: { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }, searchText: name };
            const scope: Scope = { uri, item, rootUri: pathToFileURL(path.join(path.dirname(file), 'files')).toString() };
            this.scope = scope;
            this.watch = this.service.watch(item, () => { void this.refresh(scope); });
            void this.refresh(scope);
        } catch (reason) { void this.host.postMessage({ command: 'scenarioPropertiesFiles', sourceUri: uri, paths: [], error: this.errorText(reason) }); }
    }
    private current(scope: Scope): boolean {
        return !this.disposed && scope === this.scope && this.host.currentSourceUri() === scope.uri;
    }
    private async assertCurrent(scope: Scope): Promise<void> {
        if (!this.current(scope) || !await this.host.validateSource(scope.uri) || !this.current(scope)) {
            throw new Error('The selected source changed. Retry the attachment action.');
        }
    }
    private async refresh(scope: Scope): Promise<void> {
        const generation = ++this.inventoryGeneration;
        try {
            await this.assertCurrent(scope);
            const paths = await this.service.listAttachmentPaths(scope.item);
            if (this.current(scope) && generation === this.inventoryGeneration) {
                await this.host.postMessage({ command: 'scenarioPropertiesFiles', sourceUri: scope.uri, itemId: scope.uri, rootUri: scope.rootUri, paths });
            }
        } catch (reason) {
            if (this.current(scope) && generation === this.inventoryGeneration) {
                await this.host.postMessage({ command: 'scenarioPropertiesFiles', sourceUri: scope.uri, itemId: scope.uri, rootUri: scope.rootUri, paths: [], error: this.errorText(reason) });
            }
        }
    }
    async handle(value: unknown): Promise<boolean> {
        if (!this.isMessage(value)) { return false; }
        const raw = value as Record<string, unknown>; const scope = this.scope;
        const transferId = typeof raw.transferId === 'string' ? raw.transferId : undefined;
        try {
            // Cancelling a known upload is safe even after its source lost focus.
            if (raw.command === 'cancelScenarioFileTransfer' && transferId && this.transfers.has(transferId)) {
                this.transfers.delete(transferId); await this.service.cancelTransfer(transferId); return true;
            }
            if (!scope || raw.sourceUri !== scope.uri || raw.itemId !== undefined && raw.itemId !== scope.uri) {
                throw new Error('The attachment target is not bound to the selected test.');
            }
            await this.assertCurrent(scope);
            if (raw.command === 'chooseScenarioFiles') {
                const uris = await this.host.chooseFiles?.(scope.uri);
                if (uris?.length) { await this.assertCurrent(scope); await this.importUris(scope, uris); await this.refresh(scope); }
                return true;
            }
            if (raw.command === 'insertScenarioFileName') {
                const paths = await this.service.listAttachmentPaths(scope.item); await this.assertCurrent(scope);
                if (typeof raw.relativePath !== 'string' || !paths.includes(raw.relativePath)) { throw new Error('Unknown attachment.'); }
                const name = path.posix.basename(raw.relativePath);
                if (/[\r\n\0]/u.test(name) || !await this.host.insertFileName?.(name, () => this.current(scope))) { throw new Error('Choose an editable text document to insert the file name.'); }
                return true;
            }
            if (raw.command === 'addScenarioFilesFromUris') {
                await this.importUris(scope, raw.uris); await this.refresh(scope); return true;
            }
            const message = parseScenarioFilesMessage(raw);
            if (!message) { throw new Error('Invalid attachment message.'); }
            switch (message.command) {
                case 'openScenarioFile':
                    if (!await this.service.openExternal(scope.item, message.relativePath)) { throw new Error('Could not open the attachment.'); }
                    break;
                case 'revealScenarioFile':
                    if (!await this.service.revealInOs(scope.item, message.relativePath)) { throw new Error('Could not reveal the attachment.'); }
                    break;
                case 'deleteScenarioFile':
                    await this.service.deleteFile(scope.item, message.relativePath, () => this.current(scope)); await this.refresh(scope); break;
                case 'renameScenarioFile':
                    await this.service.renameFile(scope.item, message.relativePath, () => this.current(scope)); await this.refresh(scope); break;
                case 'prepareScenarioFileDrop': {
                    const plan = await this.service.prepareDrop(scope.item, message.targetRelativePath, message.entries, () => this.current(scope));
                    if (!this.current(scope)) { await Promise.all(plan.files.map(file => this.service.cancelTransfer(file.transferId))); throw new Error('The selected source changed.'); }
                    for (const file of plan.files) { this.transfers.set(file.transferId, scope); }
                    await this.host.postMessage({ command: 'scenarioFileDropPrepared', sourceUri: scope.uri, dropId: message.dropId, ...plan }); break;
                }
                case 'appendScenarioFileChunk':
                    this.requireTransfer(message.transferId, scope);
                    await this.host.postMessage({ command: 'scenarioFileChunkAccepted', sourceUri: scope.uri, transferId: message.transferId,
                        nextOffset: await this.service.appendTransferChunk(message.transferId, message.offset, message.base64) }); break;
                case 'completeScenarioFileTransfer':
                    this.requireTransfer(message.transferId, scope);
                    await this.service.completeTransfer(message.transferId); this.transfers.delete(message.transferId);
                    await this.host.postMessage({ command: 'scenarioFileTransferCompleted', sourceUri: scope.uri, transferId: message.transferId });
                    await this.refresh(scope); break;
                case 'cancelScenarioFileTransfer': break; // Unknown/cancelled IDs never reach the shared service.
                default: throw new Error('Unsupported attachment action.');
            }
        } catch (reason) {
            if (transferId && this.transfers.has(transferId)) { this.transfers.delete(transferId); await this.service.cancelTransfer(transferId); }
            await this.host.postMessage({ command: 'scenarioFileTransferFailed', sourceUri: raw.sourceUri, transferId, dropId: raw.dropId, error: this.errorText(reason) });
        }
        return true;
    }
    private requireTransfer(id: string, scope: Scope): void {
        if (this.transfers.get(id) !== scope || !this.current(scope)) { throw new Error('Unknown or stale attachment upload.'); }
    }
    private async importUris(scope: Scope, value: unknown): Promise<void> {
        if (!Array.isArray(value) || !value.length || value.length > 5000 || value.some(uri => typeof uri !== 'string')) { throw new Error('Invalid dropped files.'); }
        const files = await Promise.all((value as string[]).map(async uri => {
            const file = fileURLToPath(uri); const stat = await fs.lstat(file); const name = path.basename(file);
            if (!stat.isFile() || stat.isSymbolicLink() || /[\r\n\0]/u.test(name)) { throw new Error('Drop regular files or use the system file manager to drag a folder.'); }
            return { file, stat, name };
        }));
        if (new Set(files.map(file => file.name)).size !== files.length) { throw new Error('Drop files with duplicate names separately.'); }
        await this.assertCurrent(scope);
        const plan = await this.service.prepareDrop(scope.item, '', files.map(file => ({ clientPath: file.name, kind: 'file', size: file.stat.size })), () => this.current(scope));
        for (const transfer of plan.files) { this.transfers.set(transfer.transferId, scope); }
        try {
            for (const transfer of plan.files) {
                this.requireTransfer(transfer.transferId, scope); await this.assertCurrent(scope);
                const file = files.find(file => file.name === transfer.clientPath)!;
                const input = await fs.open(file.file, constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                    const opened = await input.stat();
                    if (!opened.isFile() || opened.ino !== file.stat.ino || opened.dev !== file.stat.dev
                        || opened.size !== file.stat.size || opened.mtimeMs !== file.stat.mtimeMs) { throw new Error('The dropped file changed while copying.'); }
                    const buffer = Buffer.alloc(256 * 1024); let offset = 0;
                    while (offset < file.stat.size) {
                        const chunk = await input.read(buffer, 0, Math.min(buffer.length, file.stat.size - offset), offset);
                        if (!chunk.bytesRead) { throw new Error('The dropped file changed while copying.'); }
                        this.requireTransfer(transfer.transferId, scope);
                        offset = await this.service.appendTransferChunk(transfer.transferId, offset, buffer.subarray(0, chunk.bytesRead).toString('base64'));
                    }
                    const after = await input.stat();
                    if (after.size !== file.stat.size || after.mtimeMs !== file.stat.mtimeMs) { throw new Error('The dropped file changed while copying.'); }
                    await this.assertCurrent(scope); await this.service.completeTransfer(transfer.transferId); this.transfers.delete(transfer.transferId);
                } finally { await input.close(); }
            }
        } finally {
            for (const transfer of plan.files) {
                if (this.transfers.delete(transfer.transferId)) { await this.service.cancelTransfer(transfer.transferId); }
            }
        }
    }
    private errorText(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
    dispose(): void { this.bindSource(undefined); this.disposed = true; }
}
