import { VanessaInfobaseClientError, type VanessaInfobaseClients, type VanessaInfobaseClientFields, type VanessaInfobaseClientAction, type VanessaInfobaseReplacement } from './vanessaInfobaseClients';
export interface VanessaInfobaseClientUi {
    input(options: { title: string; value: string; password: boolean }): Promise<string | undefined>;
    confirmReplace(localName: string, remoteName: string): Promise<boolean>;
    connectManager(): Promise<void>;
}
const invalid = () => new VanessaInfobaseClientError('The saved client action is invalid. Refresh the list.');
const id = (value: unknown): string => {
    if (typeof value !== 'string' || !value || value.length > 256 || /[\r\n\u0000]/u.test(value)) { throw invalid(); } return value;
};
/** The base comes from the host's selected record; credential values never cross the webview protocol. */
export async function handleVanessaInfobaseClientMessage(service: VanessaInfobaseClients, infobase: string, raw: unknown, ui: VanessaInfobaseClientUi): Promise<boolean> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return false; }
    const message = raw as Record<string, unknown>;
    switch (message.command) {
        case 'clientConnectManager': await ui.connectManager(); await service.refresh(); return true;
        case 'clientRefresh': await service.refresh(true); return true;
        case 'clientSave': {
            const fields = message.fields;
            const allowed = ['name', 'username', 'synonym', 'clientType', 'computerName', 'port', 'password', 'additionalParameters'];
            if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some(key => !allowed.includes(key))) { throw invalid(); }
            await service.saveClient(infobase, message.clientId === undefined ? undefined : id(message.clientId), fields as VanessaInfobaseClientFields); return true;
        }
        case 'clientImport': await service.saveRemoteClient(infobase, id(message.clientId)); return true;
        case 'clientRemove': await service.removeClient(infobase, id(message.clientId)); return true;
        case 'clientSecret': {
            const clientId = id(message.clientId); const key = message.secret;
            if (key !== 'password' && key !== 'additionalParameters') { throw invalid(); }
            const value = await service.readSecret(infobase, clientId, key);
            const entered = await ui.input({ title: key === 'password' ? 'Test client password (stored securely)' : 'Additional launch parameters (stored securely)', value, password: key === 'password' });
            if (entered !== undefined) { await service.setSecret(infobase, clientId, key, entered); } return true;
        }
        case 'clientOperate': {
            if (!service.stateFor(infobase).connection.ready && message.action !== 'disconnect') { await ui.connectManager(); await service.refresh(); }
            if (!['add', 'connect', 'disconnect', 'replace'].includes(String(message.action)) || !Array.isArray(message.clientIds) || !message.clientIds.length || message.clientIds.length > 512) { throw invalid(); }
            const ids = message.clientIds.map(id); const action = message.action as VanessaInfobaseClientAction;
            let replacement: VanessaInfobaseReplacement | undefined;
            if (action === 'replace') {
                const row = service.stateFor(infobase).rows.find(value => value.id === ids[0]);
                if (ids.length !== 1 || !row?.replaceable || !row.remoteName) { throw invalid(); }
                replacement = service.captureReplacement(infobase, ids[0]);
                if (!await ui.confirmReplace(row.name, row.remoteName)) { return true; }
            }
            await service.operate(infobase, ids, action, replacement); return true;
        }
        default: return false;
    }
}
