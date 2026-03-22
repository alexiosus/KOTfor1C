import * as vscode from 'vscode';
import { parse } from 'node-html-parser';
import { getStepsHtml } from './stepsFetcher';
import { FormExplorerElementInfo, FormExplorerSnapshot } from './formExplorerTypes';
import { ScenarioLanguage } from './gherkinLanguage';

type StepLanguage = ScenarioLanguage;
type ElementKind = 'table' | 'field' | 'button' | 'decoration' | 'group' | 'itemAddition' | 'unknown';

interface StepCatalogRow {
    ruTemplate: string;
    ruDescription: string;
    enTemplate: string;
    enDescription: string;
}

interface TableColumnDescriptor {
    key: string;
    shortKey: string;
    title: string;
    visible: boolean;
}

interface ElementLookupItem {
    element: FormExplorerElementInfo;
    parentPath: string | null;
}

interface ElementContext {
    kind: ElementKind;
    inTable: boolean;
    name: string;
    title: string;
    value: string;
    tableName: string;
    tableColumns: string[];
    tableRows: string[][];
}

interface VanessaIntent {
    ruTemplate: string;
    fallbackEnTemplate: string;
    values: (context: ElementContext) => string[];
}

export interface FormExplorerSuggestedStep {
    templateText: string;
    filledText: string;
    description: string;
    language: StepLanguage;
    score?: number;
}

const PLACEHOLDER_REGEX = /%(\d+)\s+([^"']+)/g;

const RU_STEP_FORM_EQUALS_BY_TITLE = 'Тогда элемент формы "%1 Заголовок поля" стал равен "%2 ЗначениеПоля"';
const RU_STEP_FORM_EQUALS_BY_NAME = 'Тогда элемент формы с именем \'%1 ИмяПоля\' стал равен "%2 ЗначениеПоля"';
const RU_STEP_WAIT_VALUE_BY_NAME = 'И у элемента с именем \'%1 ИмяЭлемента\' я жду значения "%2 Значение" в течение "%3 20" секунд';
const RU_STEP_MEMORIZE_FIELD_BY_NAME = 'И я запоминаю значение поля с именем \'%1 ИмяПоля\' как "%2 ИмяПеременной"';
const RU_STEP_INPUT_TEXT_FIELD_BY_NAME = 'И в поле с именем \'%1 ИмяПоля\' я ввожу текст "%2 ЗначениеПоля"';
const RU_STEP_INPUT_VARIABLE_FIELD_BY_NAME = 'И в поле с именем \'%1 ИмяПоля\' ввожу значение переменной "%2 ИмяПеременной"';
const RU_STEP_ACTIVATE_FIELD_BY_TITLE = 'И я активизирую поле "%1 Заголовок поля"';
const RU_STEP_ACTIVATE_FIELD_BY_NAME = 'И я активизирую поле с именем \'%1 ИмяПоля\'';

const RU_STEP_TABLE_FIELD_VALUE_BY_TITLE = 'И в таблице "%1 ИмяТаблицы" поле "%2 Заголовок поля" имеет значение "%3 ЗначениеПоля"';
const RU_STEP_TABLE_FIELD_VALUE_BY_NAME = 'И в таблице "%1 ИмяТаблицы" поле с именем \'%2 ИмяПоля\' имеет значение "%3 ЗначениеПоля"';
const RU_STEP_TABLE_EQUALS_TEMPLATE = 'И таблица "%1 ИмяТаблицы" равна макету "%2 ИмяМакета"';
const RU_STEP_TABLE_BECAME_EQUAL = 'И таблица "%1 ИмяТаблицы" стала равной:';
const RU_STEP_TABLE_BECAME_EQUAL_BY_TEMPLATE = 'И таблица "%1 ИмяТаблицы" стала равной по шаблону:';
const RU_STEP_TABLE_CONTAINS_LINES = 'И таблица "%1 ИмяТаблицы" содержит строки:';
const RU_STEP_TABLE_CONTAINS_LINES_BY_TEMPLATE = 'И таблица "%1 ИмяТаблицы" содержит строки по шаблону:';
const RU_STEP_TABLE_ACTIVATE_FIELD_BY_TITLE = 'И в таблице "%1 ИмяТаблицы" я активизирую поле "%2 Заголовок поля"';
const RU_STEP_TABLE_ACTIVATE_FIELD_BY_NAME = 'И в таблице "%1 ИмяТаблицы" я активизирую поле с именем \'%2 ИмяПоля\'';
const RU_STEP_TABLE_MEMORIZE_FIELD_BY_NAME = 'И я запоминаю значение поля с именем \'%1 ИмяПоля\' таблицы "%2 ИмяТаблицы" как "%3 ИмяПеременной"';
const RU_STEP_TABLE_GO_FIRST_ROW = 'И в таблице "%1 ИмяТаблицы" я перехожу к первой строке';
const RU_STEP_TABLE_GO_LAST_ROW = 'И в таблице "%1 ИмяТаблицы" я перехожу к последней строке';
const RU_STEP_TABLE_WAIT_ROW_COUNT = 'И я жду, что в таблице "%1 ИмяТаблицы" количество строк будет "%2 больше" "%3 0" в течение "%4 20" секунд';
const RU_STEP_TABLE_FOR_EACH_ROW = 'И для каждой строки таблицы "%1 ИмяТаблицы" я выполняю';

const RU_STEP_BUTTON_CLICK_BY_TITLE = 'И я нажимаю на кнопку "%1 Заголовок кнопки"';
const RU_STEP_BUTTON_CLICK_BY_NAME = 'И я нажимаю на кнопку с именем \'%1 ИмяКнопки\'';

const RU_STEP_GROUP_WAIT_APPEAR_BY_TITLE = 'И я жду появления элемента "%1 Заголовок элемента" в течение "%2 20" секунд';
const RU_STEP_GROUP_WAIT_APPEAR_BY_NAME = 'И я жду появления элемента с именем \'%1 ИмяЭлемента\' в течение "%2 20" секунд';

const RU_STEP_CLICK_HYPERLINK = 'И я нажимаю на гиперссылку "%1 Гиперссылка"';
const RU_STEP_CLICK_HYPERLINK_BY_NAME = 'И я нажимаю на гиперссылку с именем \'%1 Гиперссылка\'';

const EN_STEP_TABLE_BECAME_EQUAL = 'And "%1 TableName" table became equal';
const EN_STEP_TABLE_BECAME_EQUAL_BY_TEMPLATE = 'And "%1 TableName" table became equal by template';
const EN_STEP_TABLE_CONTAINS_LINES = 'And "%1 TableName" table contains lines';
const EN_STEP_TABLE_CONTAINS_LINES_BY_TEMPLATE = 'And "%1 TableName" table contains rows by template:';

let cachedCatalogIndexPromise: Promise<Map<string, StepCatalogRow>> | null = null;

function normalizeText(value: string): string {
    return value
        .replace(/\r\n|\r/g, '\n')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase()
        .replace(/ё/g, 'е');
}

function normalizeQuery(value: string): string {
    return String(value || '').trim().toLocaleLowerCase();
}

function isTableLikeProbe(probe: string, hasInlineTableData: boolean = false): boolean {
    return hasInlineTableData
        || probe.includes('table')
        || probe.includes('таблиц')
        || probe.includes('dynamiclist')
        || probe.includes('dynamic list')
        || probe.includes('динамическийспис')
        || probe.includes('динамический спис');
}

function normalizeDisplayText(value: string): string {
    return value
        .replace(/\r\n|\r/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeTemplateKey(value: string): string {
    return normalizeText(value).replace(/'/g, '"');
}

function firstNonEmpty(...values: Array<string | undefined | null>): string {
    for (const value of values) {
        if (typeof value !== 'string') {
            continue;
        }
        const trimmed = value.trim();
        if (trimmed.length > 0) {
            return trimmed;
        }
    }
    return '';
}

function lastSegment(value: string | undefined): string {
    if (!value) {
        return '';
    }
    const segments = value.split('.').filter(Boolean);
    return segments[segments.length - 1] || '';
}

function humanizeToken(value: string | undefined): string {
    if (!value) {
        return '';
    }

    return value
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
}

function humanizeMetadataPath(candidatePath: string | undefined): string {
    if (!candidatePath) {
        return '';
    }
    const segment = lastSegment(candidatePath);
    return humanizeToken(segment) || candidatePath;
}

function sanitizeInlineValue(value: string): string {
    const normalized = String(value || '')
        .replace(/\r\n|\r|\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // Snapshot values can represent an empty string as explicit quotes ("" or '').
    // Placeholder templates already wrap values in quotes, so keep this as empty text.
    if (normalized === '""' || normalized === "''") {
        return '';
    }

    return normalized;
}

function sanitizeTableCellValue(value: unknown): string {
    if (value === undefined || value === null) {
        return '';
    }

    const normalized = String(value);
    const trimmed = normalized.trim();
    if (trimmed === '""' || trimmed === "''") {
        return '';
    }

    return normalized;
}

function isTableColumnElement(element: FormExplorerElementInfo | undefined): boolean {
    if (!element) {
        return false;
    }

    const probe = normalizeQuery([element.kind, element.type].filter(Boolean).join(' '));
    return probe.includes('field') || probe.includes('поле');
}

function toCaseFoldKey(value: string): string {
    return normalizeQuery(value).replace(/[\s._-]+/g, '');
}

function trimTechnicalTablePrefix(columnName: string, tableName: string): string {
    const rawColumn = String(columnName || '');
    const rawTable = String(tableName || '');
    if (!rawColumn || !rawTable) {
        return rawColumn;
    }

    if (rawColumn.length > rawTable.length && rawColumn.toLowerCase().startsWith(rawTable.toLowerCase())) {
        return rawColumn.slice(rawTable.length);
    }

    return rawColumn;
}

function buildFallbackColumnTitle(rawColumnName: string, tableName: string): string {
    const rawName = sanitizeTableCellValue(rawColumnName);
    if (!rawName) {
        return '';
    }

    const withoutPrefix = trimTechnicalTablePrefix(rawName, tableName);
    if (/^(line(number)?|linenumber)$/i.test(withoutPrefix)) {
        return '#';
    }

    return humanizeToken(withoutPrefix) || rawName;
}

function collectTableColumnDescriptorsFromElement(
    tableElement: FormExplorerElementInfo | undefined,
    tableName: string
): TableColumnDescriptor[] {
    if (!tableElement || !Array.isArray(tableElement.children)) {
        return [];
    }

    const descriptors: TableColumnDescriptor[] = [];
    for (const child of tableElement.children) {
        if (!isTableColumnElement(child)) {
            continue;
        }

        const name = firstNonEmpty(child.name, lastSegment(child.path));
        if (!name) {
            continue;
        }

        descriptors.push({
            key: toCaseFoldKey(name),
            shortKey: toCaseFoldKey(trimTechnicalTablePrefix(name, tableName)),
            title: firstNonEmpty(child.title, child.synonym, buildFallbackColumnTitle(name, tableName)),
            visible: child.visible !== false
        });
    }

    return descriptors;
}

function findColumnDescriptor(
    descriptors: TableColumnDescriptor[],
    rawColumnName: string,
    tableName: string
): TableColumnDescriptor | undefined {
    if (descriptors.length === 0) {
        return undefined;
    }

    const key = toCaseFoldKey(rawColumnName);
    const shortKey = toCaseFoldKey(trimTechnicalTablePrefix(rawColumnName, tableName));
    return descriptors.find(descriptor => {
        return descriptor.key === key
            || (descriptor.shortKey && descriptor.shortKey === key)
            || (shortKey && (descriptor.key === shortKey || descriptor.shortKey === shortKey));
    });
}

function projectTableDataForDisplay(
    tableColumnsRaw: string[],
    tableRowsRaw: string[][],
    tableElement: FormExplorerElementInfo | undefined,
    tableName: string
): { columns: string[]; rows: string[][] } {
    if (!Array.isArray(tableColumnsRaw) || tableColumnsRaw.length === 0) {
        return {
            columns: tableColumnsRaw,
            rows: tableRowsRaw
        };
    }

    const descriptors = collectTableColumnDescriptorsFromElement(tableElement, tableName);
    const selectedIndexes: number[] = [];
    const selectedColumns: string[] = [];

    for (let index = 0; index < tableColumnsRaw.length; index += 1) {
        const rawColumnName = sanitizeTableCellValue(tableColumnsRaw[index]);
        const descriptor = findColumnDescriptor(descriptors, rawColumnName, tableName);
        if (descriptor && descriptor.visible === false) {
            continue;
        }

        selectedIndexes.push(index);
        selectedColumns.push(firstNonEmpty(descriptor?.title, buildFallbackColumnTitle(rawColumnName, tableName)));
    }

    if (selectedIndexes.length === 0) {
        return {
            columns: tableColumnsRaw.map(column => sanitizeTableCellValue(column)),
            rows: tableRowsRaw
        };
    }

    const rows = tableRowsRaw.map(row => {
        const sourceRow = Array.isArray(row) ? row : [];
        return selectedIndexes.map(index => sanitizeTableCellValue(sourceRow[index]));
    });

    return {
        columns: selectedColumns,
        rows
    };
}

function parseCatalogRows(htmlContent: string): Map<string, StepCatalogRow> {
    const index = new Map<string, StepCatalogRow>();
    if (!htmlContent) {
        return index;
    }

    const root = parse(htmlContent);
    const rows = root.querySelectorAll('tr');

    for (const row of rows) {
        const rowClass = row.classNames;
        if (!rowClass || !String(rowClass).startsWith('R')) {
            continue;
        }

        const cells = row.querySelectorAll('td');
        if (cells.length < 2) {
            continue;
        }

        const ruTemplate = normalizeDisplayText(cells[0].textContent || '');
        const ruDescription = normalizeDisplayText(cells[1].textContent || '');
        const enTemplate = cells.length >= 4 ? normalizeDisplayText(cells[2].textContent || '') : '';
        const enDescription = cells.length >= 4 ? normalizeDisplayText(cells[3].textContent || '') : '';

        if (!ruTemplate) {
            continue;
        }

        const key = normalizeTemplateKey(ruTemplate);
        const existing = index.get(key);
        if (!existing) {
            index.set(key, {
                ruTemplate,
                ruDescription,
                enTemplate,
                enDescription
            });
            continue;
        }

        if (!existing.enTemplate && enTemplate) {
            existing.enTemplate = enTemplate;
        }
        if (!existing.enDescription && enDescription) {
            existing.enDescription = enDescription;
        }
        if (!existing.ruDescription && ruDescription) {
            existing.ruDescription = ruDescription;
        }
    }

    return index;
}

async function getCatalogIndex(context: vscode.ExtensionContext): Promise<Map<string, StepCatalogRow>> {
    if (!cachedCatalogIndexPromise) {
        cachedCatalogIndexPromise = getStepsHtml(context)
            .then(parseCatalogRows)
            .catch(error => {
                cachedCatalogIndexPromise = null;
                throw error;
            });
    }
    return cachedCatalogIndexPromise;
}

function detectElementKind(element: FormExplorerElementInfo): ElementKind {
    const probe = normalizeText(`${element.kind || ''} ${element.type || ''}`);

    if (isTableLikeProbe(probe, Boolean(element.tableData))) {
        return 'table';
    }
    if (probe.includes('button') || probe.includes('кноп')) {
        return 'button';
    }
    if (probe.includes('decoration') || probe.includes('декорац') || probe.includes('label')) {
        return 'decoration';
    }
    if (probe.includes('group') || probe.includes('групп')) {
        return 'group';
    }
    if (probe.includes('formitemaddition') || probe.includes('item addition') || probe.includes('addition')) {
        return 'itemAddition';
    }
    if (probe.includes('field') || probe.includes('поле')) {
        return 'field';
    }

    return 'unknown';
}

function buildElementLookup(snapshot: FormExplorerSnapshot): Map<string, ElementLookupItem> {
    const lookup = new Map<string, ElementLookupItem>();

    const visit = (elements: FormExplorerElementInfo[], parentPath: string | null): void => {
        for (const element of elements) {
            lookup.set(element.path, {
                element,
                parentPath
            });
            visit(element.children || [], element.path);
        }
    };

    visit(snapshot.elements || [], null);
    return lookup;
}

function findNearestTableOwner(
    lookup: Map<string, ElementLookupItem>,
    elementPath: string
): FormExplorerElementInfo | undefined {
    let currentPath: string | null = elementPath;

    while (currentPath) {
        const item = lookup.get(currentPath);
        if (!item) {
            break;
        }

        if (detectElementKind(item.element) === 'table') {
            return item.element;
        }

        currentPath = item.parentPath;
    }

    return undefined;
}

function findTableElementByBoundPath(
    elements: FormExplorerElementInfo[],
    targetPath: string | undefined
): FormExplorerElementInfo | undefined {
    if (!targetPath) {
        return undefined;
    }

    for (const element of elements || []) {
        const isTable = isTableLikeProbe(normalizeQuery([element.kind, element.type].filter(Boolean).join(' ')));
        if (isTable && firstNonEmpty(element.boundAttributePath) === targetPath) {
            return element;
        }

        const nested = findTableElementByBoundPath(element.children || [], targetPath);
        if (nested) {
            return nested;
        }
    }

    return undefined;
}

function findElementPathChain(
    elements: FormExplorerElementInfo[],
    targetPath: string,
    chain: FormExplorerElementInfo[] = []
): FormExplorerElementInfo[] {
    for (const element of elements || []) {
        const currentChain = [...chain, element];
        if (element.path === targetPath) {
            return currentChain;
        }

        const nested = findElementPathChain(element.children || [], targetPath, currentChain);
        if (nested.length > 0) {
            return nested;
        }
    }

    return [];
}

function getElementLabel(
    element: FormExplorerElementInfo | undefined,
    attributesByPath: Map<string, { title?: string; synonym?: string }>
): string {
    if (!element) {
        return '';
    }
    const linkedAttribute = element.boundAttributePath
        ? attributesByPath.get(element.boundAttributePath)
        : undefined;

    return firstNonEmpty(
        element.title,
        linkedAttribute?.title,
        linkedAttribute?.synonym,
        element.synonym,
        humanizeToken(element.name),
        humanizeMetadataPath(element.boundAttributePath),
        humanizeMetadataPath(element.path)
    );
}

function getTableElementUiLabel(
    tableElement: FormExplorerElementInfo | undefined,
    allElements: FormExplorerElementInfo[],
    attributesByPath: Map<string, { title?: string; synonym?: string }>
): string {
    if (!tableElement) {
        return '';
    }

    const directLabel = firstNonEmpty(tableElement.title, tableElement.synonym);
    if (directLabel) {
        return directLabel;
    }

    const chain = findElementPathChain(allElements, tableElement.path);
    if (chain.length > 1) {
        const ancestors = chain.slice(0, -1).reverse();
        for (const ancestor of ancestors) {
            const ancestorLabel = firstNonEmpty(ancestor.title, ancestor.synonym);
            if (!ancestorLabel) {
                continue;
            }

            const probe = normalizeQuery([ancestor.kind, ancestor.type, ancestor.name].filter(Boolean).join(' '));
            if (probe.includes('page') || probe.includes('вклад') || probe.includes('tab')) {
                return ancestorLabel;
            }
        }

        for (const ancestor of ancestors) {
            const ancestorLabel = firstNonEmpty(ancestor.title, ancestor.synonym);
            if (ancestorLabel) {
                return ancestorLabel;
            }
        }
    }

    return getElementLabel(tableElement, attributesByPath);
}

function buildElementContext(snapshot: FormExplorerSnapshot, element: FormExplorerElementInfo): ElementContext {
    const lookup = buildElementLookup(snapshot);
    const kind = detectElementKind(element);
    const allElements = snapshot.elements || [];
    const attributesByPath = new Map(
        (snapshot.attributes || []).map(attribute => [
            attribute.path,
            {
                title: attribute.title,
                synonym: attribute.synonym
            }
        ])
    );
    const linkedAttribute = element.boundAttributePath
        ? snapshot.attributes.find(attribute => attribute.path === element.boundAttributePath)
        : undefined;

    const tableOwner = findNearestTableOwner(lookup, element.path);
    const tableOwnerInfo = tableOwner
        ? snapshot.tables.find(table => table.elementPath === tableOwner.path || table.path === tableOwner.path || table.name === tableOwner.name)
        : undefined;
    const selfTableInfo = snapshot.tables.find(table => table.elementPath === element.path || table.path === element.path || table.name === element.name);
    const effectiveTableInfo = tableOwnerInfo || selfTableInfo;
    const effectiveTableData = effectiveTableInfo?.tableData || element.tableData;

    const name = firstNonEmpty(element.name, lastSegment(element.path), 'Field');
    const title = firstNonEmpty(
        element.title,
        element.synonym,
        linkedAttribute?.title,
        linkedAttribute?.synonym,
        humanizeToken(name),
        name
    );

    const tableElement = tableOwner
        || (kind === 'table' ? element : undefined)
        || (effectiveTableInfo?.elementPath ? lookup.get(effectiveTableInfo.elementPath)?.element : undefined)
        || findTableElementByBoundPath(allElements, firstNonEmpty(effectiveTableInfo?.boundAttributePath, effectiveTableInfo?.path));
    const value = firstNonEmpty(element.valuePreview, linkedAttribute?.valuePreview, title);
    const tableName = firstNonEmpty(
        getTableElementUiLabel(tableElement, allElements, attributesByPath),
        effectiveTableInfo?.title,
        effectiveTableInfo?.name,
        tableOwner?.title,
        tableOwner?.synonym,
        tableOwner?.name,
        'Table'
    );
    const projected = projectTableDataForDisplay(
        (effectiveTableData?.columns || []).map(column => sanitizeTableCellValue(column)),
        (effectiveTableData?.rows || []).map(row => Array.isArray(row) ? row.map(cell => sanitizeTableCellValue(cell)) : []),
        tableElement,
        tableName
    );
    const tableColumns = projected.columns.filter(column => column.length > 0);
    const tableRows = projected.rows.filter(row => row.length > 0);

    return {
        kind,
        inTable: Boolean(tableOwner) && kind !== 'table',
        name,
        title,
        value,
        tableName,
        tableColumns,
        tableRows
    };
}

function createIntent(
    ruTemplate: string,
    fallbackEnTemplate: string,
    values: (context: ElementContext) => string[]
): VanessaIntent {
    return {
        ruTemplate,
        fallbackEnTemplate,
        values
    };
}

function buildNonTableFieldIntents(): VanessaIntent[] {
    return [
        createIntent(RU_STEP_FORM_EQUALS_BY_TITLE, 'Then "%1 FieldName" form attribute became equal to "%2 FieldValue"', context => [context.title, context.value]),
        createIntent(RU_STEP_FORM_EQUALS_BY_NAME, 'Then the form attribute named "%1 FieldName" became equal to "%2 FieldValue"', context => [context.name, context.value]),
        createIntent(RU_STEP_WAIT_VALUE_BY_NAME, 'And I wait "%2 Value" value of the attribute named "%1 AttributeName" for "%3 20" seconds', context => [context.name, context.value, '60']),
        createIntent(RU_STEP_MEMORIZE_FIELD_BY_NAME, 'And I save the value of the field named "%1 FieldName" as "%2 VariableName"', context => [context.name, context.name]),
        createIntent(RU_STEP_INPUT_TEXT_FIELD_BY_NAME, 'And I input "%2 FieldValue" text in the field named "%1 FieldName"', context => [context.name, context.value]),
        createIntent(RU_STEP_INPUT_VARIABLE_FIELD_BY_NAME, 'And I input "%2 VariableName" variable value in the field named "%1 FieldName"', context => [context.name, context.name])
    ];
}

function buildTableFieldIntents(): VanessaIntent[] {
    return [
        createIntent(RU_STEP_TABLE_FIELD_VALUE_BY_TITLE, 'And in "%1 TableName" table "%2 FieldHeader" field is equal to "%3 FieldValue"', context => [context.tableName, context.title, context.value]),
        createIntent(RU_STEP_TABLE_FIELD_VALUE_BY_NAME, 'And the field named "%2 FieldName" in "%1 TableName" table is equal to "%3 FieldValue"', context => [context.tableName, context.name, context.value]),
        createIntent(RU_STEP_TABLE_EQUALS_TEMPLATE, 'And "%1 TableName" table is equal to "%2 TemplateName"', context => [context.tableName, 'ИмяМакета']),
        createIntent(RU_STEP_TABLE_ACTIVATE_FIELD_BY_TITLE, 'And I activate "%2 FieldName" field in "%1 TableName" table', context => [context.tableName, context.title]),
        createIntent(RU_STEP_TABLE_ACTIVATE_FIELD_BY_NAME, 'And I activate field named "%2 FieldName" in "%1 TableName" table', context => [context.tableName, context.name]),
        createIntent(RU_STEP_TABLE_MEMORIZE_FIELD_BY_NAME, 'And I save the value of the field named "%1 FieldName" of "%2 TableName" table as "%3 VariableName"', context => [context.name, context.tableName, context.name]),
        createIntent(RU_STEP_TABLE_GO_FIRST_ROW, 'And I go to the first line in "%1 TableName" table', context => [context.tableName]),
        createIntent(RU_STEP_TABLE_GO_LAST_ROW, 'And I go to the last line in "%1 TableName" table', context => [context.tableName]),
        createIntent(RU_STEP_TABLE_WAIT_ROW_COUNT, 'And I wait that in "%1 TableName" table number of lines will be "%2 ComparisonType" "%3 ComparisonNumber" for "%4 20" seconds', context => [context.tableName, 'больше', '0', '20']),
        createIntent(RU_STEP_TABLE_FOR_EACH_ROW, 'And for each line of "%1 TableName" table I do', context => [context.tableName])
    ];
}

function buildButtonIntents(): VanessaIntent[] {
    return [
        createIntent(RU_STEP_BUTTON_CLICK_BY_TITLE, 'And I click "%1 ButtonName" button', context => [context.title]),
        createIntent(RU_STEP_BUTTON_CLICK_BY_NAME, 'And I click the button named "%1 ButtonName"', context => [context.name])
    ];
}

function buildGroupIntents(): VanessaIntent[] {
    return [
        createIntent(RU_STEP_GROUP_WAIT_APPEAR_BY_TITLE, 'And I wait "%1 AttributeName" attribute appearance in "%2 Timeout" seconds', context => [context.title, '20']),
        createIntent(RU_STEP_GROUP_WAIT_APPEAR_BY_NAME, 'And I wait the attribute named "%1 AttributeName" appearance in "%2 Timeout" seconds', context => [context.name, '20'])
    ];
}

function buildDecorationIntents(): VanessaIntent[] {
    return [
        createIntent(RU_STEP_FORM_EQUALS_BY_NAME, 'Then the form attribute named "%1 FieldName" became equal to "%2 FieldValue"', context => [context.name, context.title]),
        createIntent(RU_STEP_WAIT_VALUE_BY_NAME, 'And I wait "%2 Value" value of the attribute named "%1 AttributeName" for "%3 20" seconds', context => [context.name, context.title, '30']),
        createIntent(RU_STEP_CLICK_HYPERLINK, 'And I click "%1 Hyperlink" hyperlink', context => [context.title]),
        createIntent(RU_STEP_CLICK_HYPERLINK_BY_NAME, 'And I click the hyperlink named "%1 ButtonName"', context => [context.name])
    ];
}

function buildTableIntents(): VanessaIntent[] {
    return [
        createIntent(RU_STEP_TABLE_EQUALS_TEMPLATE, 'And "%1 TableName" table is equal to "%2 TemplateName"', context => [context.tableName, 'ИмяМакета']),
        createIntent(RU_STEP_TABLE_GO_FIRST_ROW, 'And I go to the first line in "%1 TableName" table', context => [context.tableName]),
        createIntent(RU_STEP_TABLE_GO_LAST_ROW, 'And I go to the last line in "%1 TableName" table', context => [context.tableName]),
        createIntent(RU_STEP_TABLE_WAIT_ROW_COUNT, 'And I wait that in "%1 TableName" table number of lines will be "%2 ComparisonType" "%3 ComparisonNumber" for "%4 20" seconds', context => [context.tableName, 'больше', '0', '20']),
        createIntent(RU_STEP_TABLE_FOR_EACH_ROW, 'And for each line of "%1 TableName" table I do', context => [context.tableName])
    ];
}

function buildCommonActivationIntents(): VanessaIntent[] {
    return [
        createIntent(RU_STEP_ACTIVATE_FIELD_BY_TITLE, 'And I activate "%1 FieldName" field', context => [context.title]),
        createIntent(RU_STEP_ACTIVATE_FIELD_BY_NAME, 'And I activate the field named "%1 FieldName"', context => [context.name])
    ];
}

function buildVanessaIntents(context: ElementContext): VanessaIntent[] {
    const intents: VanessaIntent[] = [];

    if (context.kind === 'button') {
        intents.push(...buildButtonIntents());
    } else if (context.kind === 'group') {
        intents.push(...buildGroupIntents());
    } else if (context.kind === 'decoration') {
        if (context.inTable) {
            intents.push(...buildTableFieldIntents());
        } else {
            intents.push(...buildDecorationIntents());
        }
    } else if (context.kind === 'table') {
        intents.push(...buildTableIntents());
    } else {
        if (context.inTable) {
            intents.push(...buildTableFieldIntents());
        } else {
            intents.push(...buildNonTableFieldIntents());
        }
    }

    if (!context.inTable) {
        intents.push(...buildCommonActivationIntents());
    }

    return intents;
}

function escapeForSingleQuoted(value: string): string {
    return String(value || '')
        .replace(/\r\n|\r|\n/g, '\\n')
        .replace(/\|/g, '\\|')
        .replace(/'/g, '\'\'');
}

function escapeForDoubleQuoted(value: string): string {
    return String(value || '')
        .replace(/\r\n|\r|\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
}

function splitMultilineValue(value: string): string[] {
    const normalized = String(value || '')
        .replace(/\r\n|\r/g, '\n')
        .replace(/[ \t]+\n/g, '\n');
    if (!normalized.includes('\n')) {
        return [];
    }
    return normalized.split('\n');
}

function buildSingleColumnGherkinTable(lines: string[]): string {
    if (lines.length === 0) {
        return '';
    }
    const escapedRows = lines.map(line => [`'${escapeForSingleQuoted(line)}'`]);
    const maxWidth = escapedRows.reduce((width, row) => Math.max(width, row[0].length), 0);
    return escapedRows
        .map(row => `    | ${row[0].padEnd(maxWidth, ' ')} |`)
        .join('\n');
}

function buildAlignedGherkinTable(columns: string[], rows: string[][]): string {
    if (columns.length === 0 || rows.length === 0) {
        return '';
    }

    const columnCount = Math.max(
        columns.length,
        ...rows.map(row => row.length)
    );
    if (columnCount <= 0) {
        return '';
    }

    const normalizedColumns: string[] = [];
    for (let index = 0; index < columnCount; index++) {
        normalizedColumns.push(columns[index] || `Column${index + 1}`);
    }

    const normalizedRows = rows.map(row => {
        const normalizedRow: string[] = [];
        for (let index = 0; index < columnCount; index++) {
            normalizedRow.push(row[index] || '');
        }
        return normalizedRow;
    });

    const escapedRows = [normalizedColumns, ...normalizedRows]
        .map(row => row.map(cell => `'${escapeForSingleQuoted(cell)}'`));
    const widths = new Array<number>(columnCount).fill(0);
    for (const row of escapedRows) {
        for (let index = 0; index < columnCount; index++) {
            const width = row[index]?.length || 0;
            if (width > widths[index]) {
                widths[index] = width;
            }
        }
    }

    return escapedRows
        .map(row => {
            const padded = row.map((cell, index) => cell.padEnd(widths[index], ' '));
            return `    | ${padded.join(' | ')} |`;
        })
        .join('\n');
}

function buildVanessaMultilineSuggestions(
    context: ElementContext,
    preferredLanguage: StepLanguage
): FormExplorerSuggestedStep[] {
    const suggestions: FormExplorerSuggestedStep[] = [];
    const titleValue = escapeForDoubleQuoted(context.title);
    const nameValueDouble = escapeForDoubleQuoted(context.name);
    const nameValueSingle = escapeForSingleQuoted(context.name);
    const tableNameValue = escapeForDoubleQuoted(context.tableName);

    const valueLines = splitMultilineValue(context.value);
    if (valueLines.length > 1) {
        const valueTable = buildSingleColumnGherkinTable(valueLines);

        if (context.inTable) {
            const titleHeader = preferredLanguage === 'en'
                ? `And in "${tableNameValue}" table "${titleValue}" field is equal to`
                : `И в таблице "${tableNameValue}" поле "${titleValue}" имеет значение`;
            const nameHeader = preferredLanguage === 'en'
                ? `And the field named "${nameValueDouble}" in "${tableNameValue}" table is equal to`
                : `И в таблице "${tableNameValue}" поле с именем '${nameValueSingle}' имеет значение`;

            const titleStep = `${titleHeader}\n${valueTable}`;
            const nameStep = `${nameHeader}\n${valueTable}`;
            suggestions.push({
                templateText: titleStep,
                filledText: titleStep,
                description: '',
                language: preferredLanguage
            });
            suggestions.push({
                templateText: nameStep,
                filledText: nameStep,
                description: '',
                language: preferredLanguage
            });
        } else if (context.kind !== 'button' && context.kind !== 'group' && context.kind !== 'table') {
            const titleHeader = preferredLanguage === 'en'
                ? `Then "${titleValue}" form element became equal`
                : `Тогда элемент формы "${titleValue}" стал равен`;
            const nameHeader = preferredLanguage === 'en'
                ? `Then form element named "${nameValueDouble}" became equal`
                : `Тогда элемент формы с именем '${nameValueSingle}' стал равен`;

            const titleStep = `${titleHeader}\n${valueTable}`;
            const nameStep = `${nameHeader}\n${valueTable}`;
            suggestions.push({
                templateText: titleStep,
                filledText: titleStep,
                description: '',
                language: preferredLanguage
            });
            suggestions.push({
                templateText: nameStep,
                filledText: nameStep,
                description: '',
                language: preferredLanguage
            });
        }
    }

    if (context.tableColumns.length > 0 && context.tableRows.length > 0 && (context.kind === 'table' || context.inTable)) {
        const gherkinTable = buildAlignedGherkinTable(context.tableColumns, context.tableRows);
        if (gherkinTable) {
            const equalHeader = preferredLanguage === 'en'
                ? EN_STEP_TABLE_BECAME_EQUAL.replace('%1 TableName', tableNameValue)
                : RU_STEP_TABLE_BECAME_EQUAL.replace('%1 ИмяТаблицы', tableNameValue);
            const equalByTemplateHeader = preferredLanguage === 'en'
                ? EN_STEP_TABLE_BECAME_EQUAL_BY_TEMPLATE.replace('%1 TableName', tableNameValue)
                : RU_STEP_TABLE_BECAME_EQUAL_BY_TEMPLATE.replace('%1 ИмяТаблицы', tableNameValue);
            const containsHeader = preferredLanguage === 'en'
                ? EN_STEP_TABLE_CONTAINS_LINES.replace('%1 TableName', tableNameValue)
                : RU_STEP_TABLE_CONTAINS_LINES.replace('%1 ИмяТаблицы', tableNameValue);
            const containsByTemplateHeader = preferredLanguage === 'en'
                ? EN_STEP_TABLE_CONTAINS_LINES_BY_TEMPLATE.replace('%1 TableName', tableNameValue)
                : RU_STEP_TABLE_CONTAINS_LINES_BY_TEMPLATE.replace('%1 ИмяТаблицы', tableNameValue);

            const tableSteps = [
                `${equalHeader}\n${gherkinTable}`,
                `${equalByTemplateHeader}\n${gherkinTable}`,
                `${containsHeader}\n${gherkinTable}`,
                `${containsByTemplateHeader}\n${gherkinTable}`
            ];

            for (const tableStep of tableSteps) {
                suggestions.push({
                    templateText: tableStep,
                    filledText: tableStep,
                    description: '',
                    language: preferredLanguage
                });
            }
        }
    }

    return suggestions;
}

function fillTemplate(template: string, values: string[]): string {
    const filled = template.replace(PLACEHOLDER_REGEX, (_match, indexRaw, placeholderHintRaw) => {
        const index = Number(indexRaw);
        if (!Number.isFinite(index) || index <= 0) {
            return sanitizeInlineValue(String(placeholderHintRaw || ''));
        }

        if (index - 1 < values.length) {
            return sanitizeInlineValue(values[index - 1] ?? '');
        }

        return sanitizeInlineValue(String(placeholderHintRaw || ''));
    });

    return normalizeDisplayText(filled);
}

function resolveCatalogRow(
    catalog: Map<string, StepCatalogRow>,
    intent: VanessaIntent
): StepCatalogRow | undefined {
    return catalog.get(normalizeTemplateKey(intent.ruTemplate));
}

function resolveTemplate(
    row: StepCatalogRow | undefined,
    intent: VanessaIntent,
    preferredLanguage: StepLanguage
): { templateText: string; description: string } {
    if (!row) {
        if (preferredLanguage === 'en' && intent.fallbackEnTemplate) {
            return {
                templateText: intent.fallbackEnTemplate,
                description: ''
            };
        }

        return {
            templateText: intent.ruTemplate,
            description: ''
        };
    }

    if (preferredLanguage === 'en' && row.enTemplate) {
        return {
            templateText: row.enTemplate,
            description: row.enDescription || row.ruDescription || ''
        };
    }

    return {
        templateText: row.ruTemplate,
        description: row.ruDescription || row.enDescription || ''
    };
}

function dedupeKey(templateText: string): string {
    return normalizeTemplateKey(templateText.replace(PLACEHOLDER_REGEX, '__param__'));
}

export async function suggestFormExplorerSteps(
    context: vscode.ExtensionContext,
    snapshot: FormExplorerSnapshot,
    element: FormExplorerElementInfo,
    maxSuggestions: number = 12,
    preferredLanguage: StepLanguage = 'en'
): Promise<FormExplorerSuggestedStep[]> {
    const catalog = await getCatalogIndex(context);
    const elementContext = buildElementContext(snapshot, element);
    const intents = buildVanessaIntents(elementContext);
    const multilineSuggestions = buildVanessaMultilineSuggestions(elementContext, preferredLanguage);

    const suggestions: FormExplorerSuggestedStep[] = [];
    const dedupe = new Set<string>();
    const pushSuggestion = (candidate: FormExplorerSuggestedStep): boolean => {
        const templateText = normalizeDisplayText(candidate.templateText);
        if (!templateText) {
            return false;
        }

        const key = dedupeKey(templateText);
        if (dedupe.has(key)) {
            return false;
        }
        dedupe.add(key);

        suggestions.push({
            templateText,
            filledText: normalizeDisplayText(candidate.filledText),
            description: candidate.description || '',
            language: candidate.language
        });
        return suggestions.length >= maxSuggestions;
    };

    for (const multilineSuggestion of multilineSuggestions) {
        if (pushSuggestion(multilineSuggestion)) {
            return suggestions;
        }
    }

    for (const intent of intents) {
        const row = resolveCatalogRow(catalog, intent);
        const resolved = resolveTemplate(row, intent, preferredLanguage);
        const templateText = normalizeDisplayText(resolved.templateText);
        if (!templateText) {
            continue;
        }

        const values = intent.values(elementContext);
        const filledText = fillTemplate(templateText, values);

        if (pushSuggestion({
            templateText,
            filledText,
            description: resolved.description,
            language: preferredLanguage
        })) {
            return suggestions;
        }
    }

    return suggestions;
}
