(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.KotScenarioFilesProtocol = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const CHUNK_BYTES = 256 * 1024;
    const MAX_MANIFEST_ENTRIES = 5_000;
    const MAX_PATH_LENGTH = 8_192;

    function joinPath(parent, name) {
        return parent ? `${parent}/${name}` : name;
    }

    function normalizeClientPath(value) {
        if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
            throw new Error('Invalid dropped file path.');
        }
        const slashPath = value.replace(/\\/gu, '/');
        if (slashPath.startsWith('/') || /^[A-Za-z]:/u.test(slashPath)) {
            throw new Error('Invalid dropped file path.');
        }
        const segments = [];
        for (const segment of slashPath.split('/')) {
            if (segment === '.') {
                continue;
            }
            if (!segment || segment === '..') {
                throw new Error('Invalid dropped file path.');
            }
            segments.push(segment);
        }
        return segments.join('/');
    }

    function appendManifestEntry(entries, entry) {
        if (entries.length >= MAX_MANIFEST_ENTRIES) {
            throw new Error('The drop contains too many files.');
        }
        entries.push(entry);
    }

    function readFileEntry(entry) {
        return new Promise((resolve, reject) => entry.file(resolve, reject));
    }

    async function readDirectoryEntries(entry) {
        const reader = entry.createReader();
        const result = [];
        while (true) {
            const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
            if (!Array.isArray(batch) || batch.length === 0) {
                return result;
            }
            result.push(...batch);
        }
    }

    async function collectEntry(entry, parent, entries, filesByPath) {
        const clientPath = normalizeClientPath(joinPath(parent, entry.name));
        if (entry.isDirectory) {
            appendManifestEntry(entries, { clientPath, kind: 'directory' });
            const children = await readDirectoryEntries(entry);
            for (const child of children) {
                await collectEntry(child, clientPath, entries, filesByPath);
            }
            return;
        }
        if (!entry.isFile) {
            return;
        }
        const file = await readFileEntry(entry);
        appendManifestEntry(entries, { clientPath, kind: 'file', size: file.size });
        filesByPath.set(clientPath, file);
    }

    async function collectDropEntries(dataTransfer) {
        const entries = [];
        const filesByPath = new Map();
        const items = Array.from(dataTransfer?.items || []);
        const nativeEntries = items
            .map(item => typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null)
            .filter(Boolean);
        if (nativeEntries.length > 0) {
            for (const entry of nativeEntries) {
                await collectEntry(entry, '', entries, filesByPath);
            }
            return { entries, filesByPath };
        }
        for (const file of Array.from(dataTransfer?.files || [])) {
            const clientPath = normalizeClientPath(file.webkitRelativePath || file.name);
            appendManifestEntry(entries, { clientPath, kind: 'file', size: file.size });
            filesByPath.set(clientPath, file);
        }
        return { entries, filesByPath };
    }

    function setEditorDragData(event, node) {
        if (!event?.dataTransfer || node?.kind !== 'file' || typeof node.name !== 'string') {
            return false;
        }
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('text/plain', node.name);
        return true;
    }

    function projectDirectChildren(parentDepth, nodes) {
        const depth = Number(parentDepth || 0) + 1;
        return Object.freeze((Array.isArray(nodes) ? nodes : []).map(node => Object.freeze({
            ...node,
            label: node.name,
            depth
        })));
    }

    function scenarioResourceNodeKey(node) {
        const kind = typeof node?.kind === 'string' ? node.kind : '';
        const itemId = typeof node?.itemId === 'string' ? node.itemId : '';
        const relativePath = typeof node?.relativePath === 'string' ? node.relativePath : '';
        return [kind, itemId, relativePath].map(encodeURIComponent).join('|');
    }

    function scenarioResourceRowAction(kind, originatedFromButton) {
        if (originatedFromButton) {
            return 'none';
        }
        if (kind === 'attachments' || kind === 'directory') {
            return 'toggle';
        }
        if (kind === 'feature' || kind === 'file') {
            return 'open';
        }
        return 'none';
    }

    function scenarioResourceContextActions(kind, labels = {}) {
        const openLabel = kind === 'feature'
            ? (labels.openDefinition || 'Open definition')
            : (labels.openExternally || 'Open externally');
        const reveal = Object.freeze({
            id: 'reveal',
            label: labels.showInFileManager || 'Show in Finder / Explorer'
        });
        if (kind === 'file') {
            return Object.freeze([
                Object.freeze({ id: 'open', label: openLabel }),
                reveal,
                Object.freeze({ id: 'separator' }),
                Object.freeze({ id: 'delete', label: labels.delete || 'Delete' })
            ]);
        }
        if (kind === 'directory' || kind === 'attachments') {
            return Object.freeze([reveal]);
        }
        if (kind === 'feature') {
            return Object.freeze([Object.freeze({ id: 'open', label: openLabel })]);
        }
        return Object.freeze([]);
    }

    function scenarioDefinitionRowAction(
        hasResources,
        originatedFromInteractiveControl,
        toggleResourcesFromRow = true
    ) {
        if (originatedFromInteractiveControl) {
            return 'none';
        }
        return hasResources && toggleResourcesFromRow ? 'toggle' : 'focus';
    }

    function scenarioFileChildrenRenderTarget(requestExpanded, selectedItemMatches) {
        if (requestExpanded) {
            return 'results';
        }
        if (selectedItemMatches) {
            return 'details';
        }
        return 'none';
    }

    function scenarioResourceChildrenPresentation(expanded, animationPending) {
        if (!expanded) {
            return Object.freeze({
                className: 'scenario-resource-children',
                maxHeight: '0px'
            });
        }
        if (animationPending) {
            return Object.freeze({
                className: 'scenario-resource-children is-entering',
                maxHeight: '0px'
            });
        }
        return Object.freeze({
            className: 'scenario-resource-children expanded',
            maxHeight: 'none'
        });
    }

    function scenarioDirectoryExpansionTransition(expanded, childrenKnown) {
        if (expanded) {
            return Object.freeze({
                expanded: false,
                requestChildren: false,
                animateImmediately: false
            });
        }
        return Object.freeze({
            expanded: true,
            requestChildren: !childrenKnown,
            // Open the branch immediately even while its first directory read
            // is pending. The webview renders a loading row, so the click has
            // visible feedback and cannot look as if the next Files click
            // opened the previous branch.
            animateImmediately: true
        });
    }

    function createPendingExpansionTracker() {
        const pendingIds = new Set();

        return Object.freeze({
            request(value) {
                const id = typeof value === 'string' ? value.trim() : '';
                if (!id) {
                    return false;
                }
                pendingIds.add(id);
                return true;
            },
            has(value) {
                return typeof value === 'string' && pendingIds.has(value);
            },
            consume(value) {
                return typeof value === 'string' && pendingIds.delete(value);
            },
            cancel(value) {
                return typeof value === 'string' && pendingIds.delete(value);
            },
            clearWhere(predicate) {
                if (typeof predicate !== 'function') {
                    return;
                }
                for (const id of pendingIds) {
                    if (predicate(id)) {
                        pendingIds.delete(id);
                    }
                }
            },
            clear() {
                pendingIds.clear();
            },
            values() {
                return pendingIds.values();
            }
        });
    }

    function featureNameFromUri(value) {
        if (typeof value !== 'string' || !value) {
            return '';
        }
        const withoutQuery = value.split(/[?#]/u, 1)[0].replace(/\\/gu, '/');
        const encodedName = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
        try {
            return decodeURIComponent(encodedName);
        } catch {
            return encodedName;
        }
    }

    function projectCompiledScenarioChildren(item, labels) {
        const itemId = typeof item?.itemId === 'string'
            ? item.itemId
            : (typeof item?.id === 'string' ? item.id : '');
        const featureUri = typeof item?.compiledFeatureUri === 'string'
            ? item.compiledFeatureUri
            : '';
        const filesRootUri = typeof item?.scenarioFilesRootUri === 'string'
            ? item.scenarioFilesRootUri
            : '';
        if (!itemId || !featureUri || !filesRootUri) {
            return Object.freeze([]);
        }
        const depth = Number(item.depth || 0) + 1;
        const encodedItemId = encodeURIComponent(itemId);
        const featureName = featureNameFromUri(featureUri);
        const scenarioKey = typeof item?.scenarioKey === 'string' && item.scenarioKey.trim()
            ? item.scenarioKey.trim()
            : '';
        const filesLabel = typeof labels?.files === 'string' && labels.files
            ? labels.files
            : 'Files';
        return Object.freeze([
            Object.freeze({
                id: `scenario-feature:${encodedItemId}`,
                kind: 'feature',
                itemId,
                label: featureName,
                name: featureName,
                ...(scenarioKey ? { scenarioKey } : {}),
                depth,
                expandable: false
            }),
            Object.freeze({
                id: `scenario-attachments:${encodedItemId}`,
                kind: 'attachments',
                itemId,
                label: filesLabel,
                name: filesLabel,
                relativePath: '',
                depth,
                expandable: true
            })
        ]);
    }

    function bytesToBase64(bytes) {
        let binary = '';
        const stride = 0x8000;
        for (let index = 0; index < bytes.length; index += stride) {
            binary += String.fromCharCode(...bytes.subarray(index, index + stride));
        }
        return btoa(binary);
    }

    function createTransferController(postMessage) {
        const drops = new Map();
        const transfers = new Map();
        let nextId = 1;
        let activeTransferId = null;

        async function beginDrop(dataTransfer, target) {
            const collected = await collectDropEntries(dataTransfer);
            if (collected.entries.length === 0) {
                return null;
            }
            const dropId = `drop-${Date.now()}-${nextId++}`;
            drops.set(dropId, collected);
            postMessage({
                command: 'prepareScenarioFileDrop',
                dropId,
                itemId: target.itemId,
                targetRelativePath: target.relativePath || '',
                entries: collected.entries
            });
            return dropId;
        }

        async function sendNextChunk(transfer) {
            const end = Math.min(transfer.offset + CHUNK_BYTES, transfer.file.size);
            if (end === transfer.offset) {
                postMessage({
                    command: 'completeScenarioFileTransfer',
                    transferId: transfer.transferId
                });
                return;
            }
            const buffer = await transfer.file.slice(transfer.offset, end).arrayBuffer();
            postMessage({
                command: 'appendScenarioFileChunk',
                transferId: transfer.transferId,
                offset: transfer.offset,
                base64: bytesToBase64(new Uint8Array(buffer))
            });
        }

        function sendNextChunkSafely(transfer) {
            void sendNextChunk(transfer).catch(() => {
                transfers.delete(transfer.transferId);
                postMessage({
                    command: 'cancelScenarioFileTransfer',
                    transferId: transfer.transferId
                });
                if (activeTransferId === transfer.transferId) {
                    activeTransferId = null;
                    startNextTransfer();
                }
            });
        }

        function startNextTransfer() {
            if (activeTransferId !== null) {
                return;
            }
            const next = [...transfers.values()].find(transfer => transfer.started !== true);
            if (!next) {
                return;
            }
            next.started = true;
            activeTransferId = next.transferId;
            sendNextChunkSafely(next);
        }

        function handleMessage(message) {
            if (message?.command === 'scenarioFileDropPrepared') {
                const drop = drops.get(message.dropId);
                drops.delete(message.dropId);
                if (!drop) {
                    return false;
                }
                for (const accepted of message.files || []) {
                    const file = drop.filesByPath.get(accepted.clientPath);
                    if (!file) {
                        postMessage({
                            command: 'cancelScenarioFileTransfer',
                            transferId: accepted.transferId
                        });
                        continue;
                    }
                    const transfer = {
                        transferId: accepted.transferId,
                        file,
                        offset: 0,
                        started: false
                    };
                    transfers.set(transfer.transferId, transfer);
                }
                startNextTransfer();
                return true;
            }
            if (message?.command === 'scenarioFileChunkAccepted') {
                const transfer = transfers.get(message.transferId);
                if (!transfer) {
                    return false;
                }
                transfer.offset = message.nextOffset;
                sendNextChunkSafely(transfer);
                return true;
            }
            if (
                message?.command === 'scenarioFileTransferCompleted'
                || message?.command === 'scenarioFileTransferFailed'
            ) {
                if (message.dropId) {
                    drops.delete(message.dropId);
                }
                transfers.delete(message.transferId);
                if (activeTransferId === message.transferId) {
                    activeTransferId = null;
                    startNextTransfer();
                }
                return true;
            }
            return false;
        }

        function dispose() {
            for (const transferId of transfers.keys()) {
                postMessage({ command: 'cancelScenarioFileTransfer', transferId });
            }
            drops.clear();
            transfers.clear();
            activeTransferId = null;
        }

        return Object.freeze({ beginDrop, handleMessage, dispose });
    }

    return Object.freeze({
        CHUNK_BYTES,
        collectDropEntries,
        setEditorDragData,
        projectDirectChildren,
        projectCompiledScenarioChildren,
        scenarioResourceNodeKey,
        scenarioResourceRowAction,
        scenarioResourceContextActions,
        scenarioDefinitionRowAction,
        scenarioFileChildrenRenderTarget,
        scenarioResourceChildrenPresentation,
        scenarioDirectoryExpansionTransition,
        createPendingExpansionTracker,
        createTransferController
    });
}));
