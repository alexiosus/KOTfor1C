export interface FormExplorerSourceLocation {
    path: string;
    line?: number;
    column?: number;
}

export interface FormExplorerSourceInfo {
    application?: string;
    adapter?: string;
    origin?: string;
    infobase?: string;
    platformVersion?: string;
    configurationVersion?: string;
    user?: string;
    sessionId?: string;
    host?: string;
    project?: string;
    configurationSourceDirectory?: string;
}

export interface FormExplorerFormInfo {
    title?: string;
    windowTitle?: string;
    name?: string;
    metadataPath?: string;
    type?: string;
    viewKind?: string;
    activeElementPath?: string;
    source?: FormExplorerSourceLocation;
    notes?: string[];
}

export interface FormExplorerAttributeInfo {
    path: string;
    name: string;
    title?: string;
    synonym?: string;
    type?: string;
    valuePreview?: string;
    visible?: boolean;
    available?: boolean;
    readOnly?: boolean;
    required?: boolean;
    metadataPath?: string;
    source?: FormExplorerSourceLocation;
}

export interface FormExplorerElementInfo {
    path: string;
    name?: string;
    title?: string;
    synonym?: string;
    toolTip?: string;
    inputHint?: string;
    titleDataPath?: string;
    kind?: string;
    type?: string;
    boundAttributePath?: string;
    visible?: boolean;
    available?: boolean;
    enabled?: boolean;
    readOnly?: boolean;
    active?: boolean;
    valuePreview?: string;
    tableData?: FormExplorerTableData;
    metadataPath?: string;
    source?: FormExplorerSourceLocation;
    children: FormExplorerElementInfo[];
}

export interface FormExplorerTableData {
    columns: string[];
    rows: string[][];
    rowCount?: number;
    truncated?: boolean;
    sourcePath?: string;
}

export interface FormExplorerTableInfo {
    path?: string;
    name?: string;
    title?: string;
    elementPath?: string;
    boundAttributePath?: string;
    sourcePath?: string;
    tableData: FormExplorerTableData;
}

export interface FormExplorerCommandInfo {
    name: string;
    title?: string;
    available?: boolean;
    action?: string;
}

export interface FormExplorerSnapshot {
    schemaVersion: number;
    generatedAt: string;
    source?: FormExplorerSourceInfo;
    form: FormExplorerFormInfo;
    elements: FormExplorerElementInfo[];
    tables: FormExplorerTableInfo[];
    attributes: FormExplorerAttributeInfo[];
    commands: FormExplorerCommandInfo[];
    notes: string[];
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as UnknownRecord
        : null;
}

function asString(value: unknown): string | undefined {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        if (value === 1) {
            return true;
        }
        if (value === 0) {
            return false;
        }
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
            return true;
        }
        if (normalized === 'false' || normalized === '0' || normalized === 'no') {
            return false;
        }
    }
    return undefined;
}

function asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = Number(value.trim());
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map(item => asString(item))
        .filter((item): item is string => !!item);
}

function toPreviewString(value: unknown): string | undefined {
    const direct = asString(value);
    if (direct) {
        return direct;
    }
    if (value === null || value === undefined) {
        return undefined;
    }
    try {
        const serialized = JSON.stringify(value);
        if (!serialized) {
            return undefined;
        }
        return serialized.length > 240 ? `${serialized.slice(0, 237)}...` : serialized;
    } catch {
        return undefined;
    }
}

function normalizeSourceLocation(value: unknown): FormExplorerSourceLocation | undefined {
    const record = asRecord(value);
    if (!record) {
        return undefined;
    }

    const path = asString(record.path) || asString(record.filePath) || asString(record.sourcePath);
    if (!path) {
        return undefined;
    }

    return {
        path,
        line: asNumber(record.line),
        column: asNumber(record.column)
    };
}

function normalizeSourceInfo(value: unknown): FormExplorerSourceInfo | undefined {
    const record = asRecord(value);
    if (!record) {
        return undefined;
    }

    const info: FormExplorerSourceInfo = {
        application: asString(record.application),
        adapter: asString(record.adapter),
        origin: asString(record.origin),
        infobase: asString(record.infobase) || asString(record.infobasePath),
        platformVersion: asString(record.platformVersion),
        configurationVersion: asString(record.configurationVersion),
        user: asString(record.user),
        sessionId: asString(record.sessionId),
        host: asString(record.host),
        project: asString(record.project),
        configurationSourceDirectory: asString(record.configurationSourceDirectory)
    };

    return Object.values(info).some(value => value !== undefined) ? info : undefined;
}

function normalizeFormInfo(value: unknown): FormExplorerFormInfo {
    const record = asRecord(value) || {};
    const notes = asStringArray(record.notes);

    return {
        title: asString(record.title) || asString(record.caption) || asString(record.synonym),
        windowTitle: asString(record.windowTitle),
        name: asString(record.name),
        metadataPath: asString(record.metadataPath),
        type: asString(record.type) || asString(record.kind),
        viewKind: asString(record.viewKind) || asString(record.viewMode),
        activeElementPath: asString(record.activeElementPath),
        source: normalizeSourceLocation(record.source),
        notes
    };
}

function normalizeAttributeInfo(value: unknown, index: number): FormExplorerAttributeInfo {
    const record = asRecord(value) || {};
    const path = asString(record.path)
        || asString(record.attributePath)
        || asString(record.name)
        || `Attribute${index + 1}`;
    const name = asString(record.name) || path;

    return {
        path,
        name,
        title: asString(record.title) || asString(record.caption),
        synonym: asString(record.synonym) || asString(record.presentation),
        type: asString(record.type),
        valuePreview: toPreviewString(record.valuePreview ?? record.value ?? record.currentValue),
        visible: asBoolean(record.visible),
        available: asBoolean(record.available),
        readOnly: asBoolean(record.readOnly),
        required: asBoolean(record.required),
        metadataPath: asString(record.metadataPath),
        source: normalizeSourceLocation(record.source)
    };
}

function normalizeCommandInfo(value: unknown, index: number): FormExplorerCommandInfo {
    const record = asRecord(value) || {};
    const name = asString(record.name) || asString(record.path) || `Command${index + 1}`;

    return {
        name,
        title: asString(record.title) || asString(record.caption) || asString(record.synonym),
        available: asBoolean(record.available),
        action: asString(record.action)
    };
}

function buildFallbackElementPath(parentPath: string | undefined, index: number, record: UnknownRecord): string {
    const selfSegment = asString(record.name)
        || asString(record.path)
        || asString(record.title)
        || asString(record.caption)
        || `Element${index + 1}`;
    return parentPath ? `${parentPath}.${selfSegment}` : selfSegment;
}

function normalizeElementInfo(
    value: unknown,
    index: number,
    parentPath: string | undefined,
    activeElementPath: string | undefined
): FormExplorerElementInfo {
    const record = asRecord(value) || {};
    const path = asString(record.path) || buildFallbackElementPath(parentPath, index, record);

    const childrenRaw = Array.isArray(record.children)
        ? record.children
        : Array.isArray(record.items)
            ? record.items
            : [];
    const active = asBoolean(record.active) ?? asBoolean(record.isActive) ?? (activeElementPath ? path === activeElementPath : undefined);

    return {
        path,
        name: asString(record.name),
        title: asString(record.title) || asString(record.caption),
        synonym: asString(record.synonym) || asString(record.presentation),
        toolTip: asString(record.toolTip) || asString(record.tooltip) || asString(record.hint),
        inputHint: asString(record.inputHint) || asString(record.placeholder),
        titleDataPath: asString(record.titleDataPath),
        kind: asString(record.kind),
        type: asString(record.type),
        boundAttributePath: asString(record.boundAttributePath) || asString(record.attributePath) || asString(record.binding),
        visible: asBoolean(record.visible),
        available: asBoolean(record.available),
        enabled: asBoolean(record.enabled),
        readOnly: asBoolean(record.readOnly),
        active,
        valuePreview: toPreviewString(record.valuePreview ?? record.value ?? record.currentValue),
        tableData: normalizeTableData(record.tableData),
        metadataPath: asString(record.metadataPath),
        source: normalizeSourceLocation(record.source),
        children: childrenRaw.map((child, childIndex) => normalizeElementInfo(child, childIndex, path, activeElementPath))
    };
}

function normalizeTableData(value: unknown): FormExplorerTableData | undefined {
    const record = asRecord(value);
    if (!record) {
        return undefined;
    }

    const columns = asStringArray(record.columns);
    const rowsRaw = Array.isArray(record.rows) ? record.rows : [];
    const rows = rowsRaw.map((row, rowIndex) => {
        if (!Array.isArray(row)) {
            return [toPreviewString(row) || `Row${rowIndex + 1}`];
        }

        return row.map(cell => toPreviewString(cell) || '');
    });

    if (columns.length === 0 && rows.length === 0) {
        return undefined;
    }

    const inferredColumns = columns.length > 0
        ? columns
        : Array.from({ length: Math.max(...rows.map(row => row.length), 0) }, (_, index) => `Column${index + 1}`);

    const rowCount = asNumber(record.rowCount);
    const truncated = asBoolean(record.truncated);

    return {
        columns: inferredColumns,
        rows,
        rowCount: rowCount ?? rows.length,
        truncated,
        sourcePath: asString(record.sourcePath)
    };
}

function normalizeTableInfo(value: unknown): FormExplorerTableInfo | undefined {
    const record = asRecord(value);
    if (!record) {
        return undefined;
    }

    const tableData = normalizeTableData(record.tableData ?? record.data ?? value);
    if (!tableData) {
        return undefined;
    }

    const path = asString(record.path) || asString(record.boundAttributePath);
    const sourcePath = asString(record.sourcePath) || tableData.sourcePath;

    return {
        path: path || sourcePath || asString(record.elementPath),
        name: asString(record.name),
        title: asString(record.title),
        elementPath: asString(record.elementPath),
        boundAttributePath: asString(record.boundAttributePath),
        sourcePath,
        tableData
    };
}

function findFirstActiveElementPath(elements: FormExplorerElementInfo[]): string | undefined {
    for (const element of elements) {
        if (element.active) {
            return element.path;
        }

        const nested = findFirstActiveElementPath(element.children);
        if (nested) {
            return nested;
        }
    }

    return undefined;
}

export function parseFormExplorerSnapshotText(rawText: string): FormExplorerSnapshot {
    const sanitizedText = rawText.replace(/^\uFEFF/, '');

    let parsed: unknown;
    try {
        parsed = JSON.parse(sanitizedText);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSON: ${message}`);
    }

    const record = asRecord(parsed);
    if (!record) {
        throw new Error('Snapshot root must be an object.');
    }

    const form = normalizeFormInfo(record.form);
    const elementsRaw = Array.isArray(record.elements) ? record.elements : [];
    const elements = elementsRaw.map((element, index) => normalizeElementInfo(element, index, undefined, form.activeElementPath));
    const inferredActivePath = form.activeElementPath || findFirstActiveElementPath(elements);

    const normalizedForm: FormExplorerFormInfo = inferredActivePath
        ? { ...form, activeElementPath: inferredActivePath }
        : form;

    const attributesRaw = Array.isArray(record.attributes) ? record.attributes : [];
    const tablesRaw = Array.isArray(record.tables) ? record.tables : [];
    const commandsRaw = Array.isArray(record.commands) ? record.commands : [];
    const notes = asStringArray(record.notes);
    const schemaVersion = asNumber(record.schemaVersion) ?? 1;
    const generatedAt = asString(record.generatedAt) || new Date().toISOString();

    return {
        schemaVersion,
        generatedAt,
        source: normalizeSourceInfo(record.source),
        form: normalizedForm,
        elements,
        tables: tablesRaw
            .map(table => normalizeTableInfo(table))
            .filter((table): table is FormExplorerTableInfo => !!table),
        attributes: attributesRaw.map((attribute, index) => normalizeAttributeInfo(attribute, index)),
        commands: commandsRaw.map((command, index) => normalizeCommandInfo(command, index)),
        notes
    };
}
