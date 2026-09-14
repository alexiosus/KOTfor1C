export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonPointer = readonly (string | number)[];

export interface AdditionalLaunchVanessaParameter {
    key: string;
    value: string;
    overrideExisting: boolean;
}

export interface JsonTransformationResult {
    value: JsonValue;
    changedCount: number;
}

const VANESSA_PARAM_ALIAS_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
    ['ВерсияVA', 'VersionVA'],
    ['КаталогФич', 'featurepath'],
    ['КаталогПроекта', 'projectpath'],
    ['КаталогиБиблиотек', 'librarycatalogs'],
    ['СписокТеговИсключение', 'ignoretags'],
    ['СписокТеговОтбор', 'filtertags'],
    ['СписокСценариевДляВыполнения', 'scenariofilter'],
    ['ЯзыкГенератораGherkin', 'gherkinlanguage'],
    ['ДобавлятьПриНакликиванииМетаИнформацию', 'addmetainformationclicking'],
    ['ИскатьЭлементыФормыПоИмени', 'searchformelementsbyname'],
    ['ПоказыватьОкноОстановкиЗаписиДействийПользователя', 'ShowWindowToStopRecordingUserActions'],
    ['ИспользоватьКомпонентуVanessaExt', 'useaddin'],
    ['ИспользоватьПарсерGherkinИзКомпонентыVanessaExt', 'usethegherkinparserfromthevanessaextaddin'],
    ['ПоискФайловСПомощьюКомпонентыVanessaExt', 'SearchingForFilesUsingTheVanessaExtComponent'],
    ['ЗавершатьРаботуЕслиНеПолучилосьВыполнитьТихуюУстановкуКомпоненты', 'QuitIfSilentInstallationAddinFails'],
    ['КаталогИнструментов', 'instrpath'],
    ['КаталогВременныхФайлов', 'TemporaryFilesDirectory'],
    ['ЗапускатьКлиентТестированияСМаксимизированнымОкном', 'runtestclientwithmaximizedwindow'],
    ['МодальноеОкноПриЗапускеТестКлиентаЭтоОшибка', 'modalwindowwhenstartingtestclientiserror'],
    ['ВыполнятьПопыткуПереподключенияЕслиПроцессТестКлиентаНеНайден', 'starttestclientsessionagainonconnectionifitsprocessisnotfound'],
    ['ЗакрыватьКлиентТестированияПринудительно', 'forceclosetestclient'],
    ['ТаймаутПередПринудительнымЗакрытиемТестКлиента', 'timeoutbeforeforciblyclosingtestclient'],
    ['ПутьКadb', 'PathToadb'],
    ['ДелатьЛогВыполненияСценариевВЖР', 'logtogr'],
    ['ЗвуковоеОповещениеПриОкончанииВыполненияСценария', 'soundnotificationwhenscriptends'],
    ['ВыполнятьШагиАсинхронно', 'makestepsasync'],
    ['ИнтервалВыполненияШагаЗаданныйПользователем', 'SpacingStepSpecifiedUser'],
    ['ОстановкаПриВозникновенииОшибки', 'stoponerror'],
    ['ПоказыватьНомерСтрокиДереваПриВозникновенииОшибки', 'showrownumberonerror'],
    ['ПриравниватьPendingКFailed', 'pendingequalfailed'],
    ['БезопасноеВыполнениеШагов', 'safeexecutionofsteps'],
    ['ТаймаутДляАсинхронныхШагов', 'timeoutforasynchronoussteps'],
    ['КоличествоСекундПоискаОкна', 'timetofindwindow'],
    ['КоличествоПопытокВыполненияДействия', 'numberofattemptstoperformanaction'],
    ['ТаймаутЗапуска1С', 'testclienttimeout'],
    ['ПаузаПриОткрытииОкна', 'pauseonwindowopening'],
    ['ВыгружатьСтатусВыполненияСценариевВФайл', 'createlogs'],
    ['ПутьКФайлуДляВыгрузкиСтатусаВыполненияСценариев', 'logpath'],
    ['ИмяТекущейСборки', 'NameCurrentBuild'],
    ['ЗагрузкаФичПриОткрытии', 'DownloadFeaturesOpen'],
    ['ДелатьЛогВыполненияСценариевВТекстовыйФайл', 'logtotext'],
    ['ВыводитьЛогВКонсоль', 'outputloginconsole'],
    ['ВыводитьВЛогВыполнениеШагов', 'logstepstotext'],
    ['ПодробныйЛогВыполненияСценариев', 'fulllog'],
    ['ИмяФайлаЛогВыполненияСценариев', 'textlogname'],
    ['ДелатьОтчетВФорматеАллюр', 'allurecreatereport'],
    ['КаталогВыгрузкиAllure', 'allurepath'],
    ['КаталогВыгрузкиAllureБазовый', 'allurepathbase'],
    ['ПодставлятьВОтчетеAllureЗначенияПеременных', 'setvariablevaluesinstepsallurereport'],
    ['ДанныеАллюрМеток', 'DataAllureMarks'],
    ['ДелатьОтчетВФорматеjUnit', 'junitcreatereport'],
    ['КаталогВыгрузкиjUnit', 'junitpath'],
    ['СкриншотыjUnit', 'junitscreenshots'],
    ['ДелатьОтчетВФорматеСППР', 'ModelingCreateReport'],
    ['КаталогВыгрузкиСППР', 'modelingreportpath'],
    ['ИмяКонфигурацииСППР', 'ModelingConfigurationName'],
    ['ВерсияКонфигурацииСППР', 'ModelingConfigurationVersion'],
    ['ДелатьОтчетВФорматеCucumberJson', 'cucumbercreatereport'],
    ['КаталогВыгрузкиCucumberJson', 'cucumberreportpath'],
    ['ДелатьЛогОшибокВТекстовыйФайл', 'logerrorstotext'],
    ['СобиратьДанныеОСостоянииАктивнойФормыПриОшибке', 'getactiveformdataonerror'],
    ['СобиратьДанныеОСостоянииВсехФормПриОшибке', 'getallformsdataonerror'],
    ['СобиратьДанныеОЗначенияхПеременных', 'CollectDataOnVariableValues'],
    ['ДелатьСкриншотПриВозникновенииОшибки', 'onerrorscreenshot'],
    ['СниматьСкриншотКаждогоОкна1С', 'onerrorscreenshoteverywindow'],
    ['ИспользоватьВнешнююКомпонентуДляСкриншотов', 'useaddinforscreencapture'],
    ['СпособСнятияСкриншотовВнешнейКомпонентой', 'screencaptureaddinmethod'],
    ['КаталогВыгрузкиСкриншотов', 'outputscreenshot'],
    ['ИмяКаталогаЛогОшибок', 'texterrorslogname'],
    ['ОткрыватьНачальнуюСтраницуПриЗапуске', 'OpenStartPageAtStartup'],
    ['ВыполнитьСценарии', 'ExecuteScenarios', 'RunScenarios'],
    ['ЗавершитьРаботуСистемы', 'CloseSystemOnComplete', 'QuitSystemOnComplete'],
    ['ЗакрытьTestClientПослеЗапускаСценариев', 'CloseTestClientAfterScenarioRun', 'CloseTestClient', 'closetestclient'],
    ['ПутьКИнфобазе', 'PathToInfobase'],
    ['ВыполнениеСценариев', 'RunningScripts'],
    ['КлиентТестирования', 'TestClient'],
    ['КлиентыТестирования', 'ДанныеКлиентовТестирования', 'datatestclients'],
    ['ПортЗапускаТестКлиента', 'PortTestClient'],
    ['ДопПараметры', 'AddItionalParameters'],
    ['ТипКлиента', 'ClientType'],
    ['ИмяКомпьютера', 'ComputerName'],
    ['Имя', 'Name'],
    ['Синоним', 'Synonym']
];

const VANESSA_PARAM_ALIAS_INDEX = (() => {
    const index = new Map<string, Set<string>>();
    for (const group of VANESSA_PARAM_ALIAS_GROUPS) {
        const normalizedGroup = Array.from(new Set(group
            .map(key => key.trim())
            .filter(key => key.length > 0)));
        if (normalizedGroup.length < 2) {
            continue;
        }
        const normalizedLookup = normalizedGroup.map(key => key.toLowerCase());
        for (const lookupKey of normalizedLookup) {
            const bucket = index.get(lookupKey) ?? new Set<string>();
            normalizedGroup.forEach(key => bucket.add(key));
            index.set(lookupKey, bucket);
        }
    }
    return index;
})();

function cloneJsonValue(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        return value.map(cloneJsonValue);
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)])
        );
    }
    return value;
}

function decodeJsonPointerToken(token: string): string | null {
    let decoded = '';
    for (let index = 0; index < token.length; index++) {
        if (token[index] !== '~') {
            decoded += token[index];
            continue;
        }

        const escape = token[index + 1];
        if (escape === '0') {
            decoded += '~';
        } else if (escape === '1') {
            decoded += '/';
        } else {
            return null;
        }
        index += 1;
    }
    return decoded;
}

function toPointerSegment(token: string): string | number {
    return /^(?:0|[1-9]\d*)$/.test(token) ? Number(token) : token;
}

export function parseJsonPointer(rawPointer: string): Array<string | number> | null {
    if (rawPointer === '') {
        return [];
    }
    if (!rawPointer.startsWith('/')) {
        return null;
    }

    const pointer: Array<string | number> = [];
    for (const rawToken of rawPointer.slice(1).split('/')) {
        const token = decodeJsonPointerToken(rawToken);
        if (token === null) {
            return null;
        }
        pointer.push(toPointerSegment(token));
    }
    return pointer;
}

function normalizeJsonPointer(pointer: string | JsonPointer): Array<string | number> | null {
    return typeof pointer === 'string' ? parseJsonPointer(pointer) : Array.from(pointer);
}

const UNSAFE_JSON_POINTER_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function hasUnsafeJsonPointerSegment(pointer: JsonPointer): boolean {
    return pointer.some(segment =>
        typeof segment === 'string' && UNSAFE_JSON_POINTER_SEGMENTS.has(segment)
    );
}

function getMutableJsonValueAtPointer(root: JsonValue, pointer: JsonPointer): JsonValue | undefined {
    let current: JsonValue | undefined = root;
    for (const segment of pointer) {
        if (current === null || typeof current !== 'object') {
            return undefined;
        }
        current = (current as Record<string | number, JsonValue>)[segment];
    }
    return current;
}

export function getJsonValueAtPointer(
    root: JsonValue,
    pointer: string | JsonPointer
): JsonValue | undefined {
    const normalizedPointer = normalizeJsonPointer(pointer);
    return normalizedPointer && !hasUnsafeJsonPointerSegment(normalizedPointer)
        ? getMutableJsonValueAtPointer(root, normalizedPointer)
        : undefined;
}

function setMutableJsonValueAtPointer(root: JsonValue, pointer: JsonPointer, value: JsonValue): boolean {
    if (pointer.length === 0 || root === null || typeof root !== 'object') {
        return false;
    }

    let current = root as Record<string | number, JsonValue>;
    for (let index = 0; index < pointer.length - 1; index++) {
        const segment = pointer[index];
        const nextSegment = pointer[index + 1];
        const currentValue = current[segment];
        if (currentValue === null || typeof currentValue !== 'object') {
            current[segment] = typeof nextSegment === 'number' ? [] : {};
        }
        current = current[segment] as Record<string | number, JsonValue>;
    }

    current[pointer[pointer.length - 1]] = value;
    return true;
}

export function setJsonValueAtPointer(
    root: JsonValue,
    pointer: string | JsonPointer,
    value: JsonValue
): JsonValue {
    const normalizedPointer = normalizeJsonPointer(pointer);
    if (!normalizedPointer || hasUnsafeJsonPointerSegment(normalizedPointer)) {
        return cloneJsonValue(root);
    }
    if (normalizedPointer.length === 0) {
        return cloneJsonValue(value);
    }

    const nextRoot = cloneJsonValue(root);
    setMutableJsonValueAtPointer(nextRoot, normalizedPointer, cloneJsonValue(value));
    return nextRoot;
}

export function parseAdditionalParameterPointer(rawKey: string): Array<string | number> | null {
    const key = rawKey.trim();
    if (!key) {
        return null;
    }
    if (key.startsWith('/')) {
        return parseJsonPointer(key);
    }
    if (!key.includes('.') && !key.includes('[')) {
        return [key];
    }

    const pointer: Array<string | number> = [];
    for (const rawSegment of key.split('.')) {
        const segment = rawSegment.trim();
        if (!segment) {
            return null;
        }

        const matcher = /([^[\]]+)|\[(\d+)\]/g;
        let cursor = 0;
        let hasMatch = false;
        let match: RegExpExecArray | null;
        while ((match = matcher.exec(segment)) !== null) {
            if (match.index !== cursor) {
                return null;
            }
            hasMatch = true;
            if (match[1] !== undefined) {
                const property = match[1].trim();
                if (!property) {
                    return null;
                }
                pointer.push(property);
            } else {
                pointer.push(Number(match[2]));
            }
            cursor = matcher.lastIndex;
        }

        if (!hasMatch || cursor !== segment.length) {
            return null;
        }
    }
    return pointer.length > 0 ? pointer : null;
}

function getAdditionalParamAliasCandidates(rawKey: string): string[] {
    const key = rawKey.trim();
    if (!key) {
        return [];
    }

    const fromIndex = VANESSA_PARAM_ALIAS_INDEX.get(key.toLowerCase());
    if (!fromIndex?.size) {
        return [key];
    }
    return Array.from(new Set([key, ...Array.from(fromIndex)]));
}

export function findObjectKeyByAlias(container: unknown, rawKey: string): string | null {
    if (!container || typeof container !== 'object' || Array.isArray(container)) {
        return null;
    }

    const objectContainer = container as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(objectContainer, rawKey)) {
        return rawKey;
    }

    const normalizedInput = rawKey.trim().toLowerCase();
    if (!normalizedInput) {
        return null;
    }
    for (const key of Object.keys(objectContainer)) {
        if (key.trim().toLowerCase() === normalizedInput) {
            return key;
        }
    }

    const aliases = getAdditionalParamAliasCandidates(rawKey)
        .map(alias => alias.trim().toLowerCase())
        .filter(alias => alias.length > 0);
    const aliasSet = new Set(aliases);
    for (const key of Object.keys(objectContainer)) {
        if (aliasSet.has(key.trim().toLowerCase())) {
            return key;
        }
    }
    return null;
}

export function resolveExistingPointerByAliases(
    root: unknown,
    pointer: JsonPointer
): Array<string | number> | null {
    let current = root;
    const resolved: Array<string | number> = [];

    for (const segment of pointer) {
        if (typeof segment === 'number') {
            if (!Array.isArray(current) || segment < 0 || segment >= current.length) {
                return null;
            }
            resolved.push(segment);
            current = current[segment];
            continue;
        }

        const resolvedKey = findObjectKeyByAlias(current, segment);
        if (!resolvedKey) {
            return null;
        }
        resolved.push(resolvedKey);
        current = (current as Record<string, unknown>)[resolvedKey];
    }
    return resolved;
}

function resolveRootPointerByLeafAlias(root: unknown, pointer: JsonPointer): Array<string | number> | null {
    if (!root || typeof root !== 'object' || Array.isArray(root) || pointer.length < 2
        || pointer.some(segment => typeof segment === 'number')) {
        return null;
    }

    const leaf = pointer[pointer.length - 1];
    if (typeof leaf !== 'string') {
        return null;
    }
    const resolvedRootKey = findObjectKeyByAlias(root, leaf);
    return resolvedRootKey ? [resolvedRootKey] : null;
}

function hasJsonValueAtPointer(root: JsonValue, pointer: JsonPointer): boolean {
    let current: JsonValue = root;
    for (const segment of pointer) {
        if (current === null || typeof current !== 'object'
            || !Object.prototype.hasOwnProperty.call(current, segment)) {
            return false;
        }
        current = (current as Record<string | number, JsonValue>)[segment];
    }
    return true;
}

function shouldSkipAdditionalParamForSpprClients(root: JsonValue, pointer: JsonPointer): boolean {
    if (!root || typeof root !== 'object' || Array.isArray(root)
        || !Object.keys(root).some(key => key.trim().toLowerCase() === 'клиентытестирования')) {
        return false;
    }

    const stringSegments = pointer
        .filter((segment): segment is string => typeof segment === 'string')
        .map(segment => segment.trim().toLowerCase())
        .filter(segment => segment.length > 0);
    const touchesClientsCollection = stringSegments.some(segment =>
        segment === 'datatestclients'
        || segment === 'клиентытестирования'
        || segment === 'данныеклиентовтестирования'
    );
    return touchesClientsCollection && !(pointer.length === 1 && typeof pointer[0] === 'string');
}

function ensureJsonPointerContainers(root: JsonValue, pointer: JsonPointer): boolean {
    if (!root || typeof root !== 'object' || pointer.length === 0) {
        return false;
    }

    let current = root as Record<string | number, JsonValue>;
    for (let index = 0; index < pointer.length - 1; index++) {
        const segment = pointer[index];
        const nextSegment = pointer[index + 1];
        const currentValue = current[segment];
        if (currentValue === null || typeof currentValue !== 'object') {
            current[segment] = typeof nextSegment === 'number' ? [] : {};
        }
        current = current[segment] as Record<string | number, JsonValue>;
    }
    return true;
}

function parseAdditionalParameterValue(
    rawValue: string,
    hasExisting: boolean,
    existingValue: JsonValue | undefined
): JsonValue {
    const source = String(rawValue ?? '');
    const trimmed = source.trim();
    const tryParseJson = (): { ok: boolean; value: JsonValue } => {
        try {
            return { ok: true, value: JSON.parse(trimmed) as JsonValue };
        } catch {
            return { ok: false, value: source };
        }
    };

    if (hasExisting) {
        if (typeof existingValue === 'string') {
            return source;
        }
        if (typeof existingValue === 'number') {
            const parsedNumber = Number(trimmed);
            return Number.isFinite(parsedNumber) ? parsedNumber : source;
        }
        if (typeof existingValue === 'boolean') {
            if (/^true$/i.test(trimmed)) {
                return true;
            }
            if (/^false$/i.test(trimmed)) {
                return false;
            }
            return source;
        }
        if (existingValue === null || typeof existingValue === 'object') {
            const parsed = tryParseJson();
            return parsed.value;
        }
        return source;
    }

    if (!trimmed) {
        return source;
    }
    const shouldTryJsonParse = trimmed.startsWith('{')
        || trimmed.startsWith('[')
        || trimmed === 'true'
        || trimmed === 'false'
        || trimmed === 'null'
        || /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed);
    return shouldTryJsonParse ? tryParseJson().value : source;
}

function areJsonValuesEqual(left: JsonValue | undefined, right: JsonValue): boolean {
    if (left === right) {
        return true;
    }
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
        return false;
    }
    return JSON.stringify(left) === JSON.stringify(right);
}

export function applyAdditionalVanessaParameters(
    root: JsonValue,
    parameters: readonly AdditionalLaunchVanessaParameter[]
): JsonTransformationResult {
    const nextRoot = cloneJsonValue(root);
    if (!nextRoot || typeof nextRoot !== 'object' || Array.isArray(nextRoot)) {
        return { value: nextRoot, changedCount: 0 };
    }

    let changedCount = 0;
    for (const parameter of parameters) {
        const key = (parameter.key || '').trim();
        if (!key) {
            continue;
        }

        const parsedPointer = parseAdditionalParameterPointer(key) ?? [key];
        if (hasUnsafeJsonPointerSegment(parsedPointer)
            || shouldSkipAdditionalParamForSpprClients(nextRoot, parsedPointer)) {
            continue;
        }
        const pointer = resolveExistingPointerByAliases(nextRoot, parsedPointer)
            ?? resolveRootPointerByLeafAlias(nextRoot, parsedPointer)
            ?? parsedPointer;
        if (hasUnsafeJsonPointerSegment(pointer)) {
            continue;
        }
        const hasExisting = hasJsonValueAtPointer(nextRoot, pointer);
        if (hasExisting && !parameter.overrideExisting) {
            continue;
        }
        if (!ensureJsonPointerContainers(nextRoot, pointer)) {
            continue;
        }

        const currentValue = hasExisting ? getMutableJsonValueAtPointer(nextRoot, pointer) : undefined;
        const nextValue = parseAdditionalParameterValue(parameter.value, hasExisting, currentValue);
        if (!areJsonValuesEqual(currentValue, nextValue)) {
            setMutableJsonValueAtPointer(nextRoot, pointer, nextValue);
            changedCount += 1;
        }
    }
    return { value: nextRoot, changedCount };
}

function resolveGlobalVarsContainer(root: JsonValue): Record<string, JsonValue> | null {
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
        return null;
    }

    const rootObject = root as Record<string, JsonValue>;
    for (const alias of ['GlobalVars', 'ГлобальныеПеременные', 'globalvariables', 'global_vars']) {
        const foundKey = findObjectKeyByAlias(rootObject, alias);
        if (!foundKey) {
            continue;
        }
        const currentValue = rootObject[foundKey];
        if (currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue)) {
            return currentValue as Record<string, JsonValue>;
        }
        const replacement: Record<string, JsonValue> = {};
        rootObject[foundKey] = replacement;
        return replacement;
    }

    const created: Record<string, JsonValue> = {};
    rootObject.GlobalVars = created;
    return created;
}

export function applyGlobalVanessaVariables(
    root: JsonValue,
    variables: readonly AdditionalLaunchVanessaParameter[]
): JsonTransformationResult {
    const nextRoot = cloneJsonValue(root);
    if (!variables.length) {
        return { value: nextRoot, changedCount: 0 };
    }
    const container = resolveGlobalVarsContainer(nextRoot);
    if (!container) {
        return { value: nextRoot, changedCount: 0 };
    }

    let changedCount = 0;
    for (const variable of variables) {
        const key = (variable.key || '').trim();
        if (!key) {
            continue;
        }
        const resolvedKey = findObjectKeyByAlias(container, key) ?? key;
        if (hasUnsafeJsonPointerSegment([resolvedKey])) {
            continue;
        }
        const hasExisting = Object.prototype.hasOwnProperty.call(container, resolvedKey);
        if (hasExisting && !variable.overrideExisting) {
            continue;
        }
        const currentValue = hasExisting ? container[resolvedKey] : undefined;
        const nextValue = parseAdditionalParameterValue(variable.value, hasExisting, currentValue);
        if (!areJsonValuesEqual(currentValue, nextValue)) {
            container[resolvedKey] = nextValue;
            changedCount += 1;
        }
    }
    return { value: nextRoot, changedCount };
}
