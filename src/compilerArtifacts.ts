export interface CompilerSourceMapEntry {
    readonly scenarioUid: string;
    readonly scenarioName: string;
    readonly scenarioCode: string;
    readonly isMain: boolean;
    readonly stepText: string;
    /** One-based line in the emitted feature. */
    readonly featureLineNumber: number;
    /** One-based line within the original ТекстСценария body, not the YAML file. */
    readonly sourceBodyLineNumber: number;
    readonly nestingLevel: number;
}

export interface CompilerSourceMap {
    readonly entries: readonly CompilerSourceMapEntry[];
    readonly mainScenarioUids: readonly string[];
}

export interface CompilerCompileInventory {
    readonly scenarioSettingsCodes: readonly string[];
    readonly processSettingsCodes: readonly string[];
}

export interface CompilerJUnitEntry {
    readonly suiteName: string;
    readonly name: string;
    readonly className: string;
    readonly status: 'passed' | 'failed' | 'error' | 'skipped';
    readonly timeSeconds: number;
    readonly message: string;
    readonly details: string;
    readonly properties: Readonly<Record<string, string>>;
}

export interface CompilerJUnitReport {
    readonly entries: readonly CompilerJUnitEntry[];
    readonly summary: {
        readonly tests: number;
        readonly failures: number;
        readonly errors: number;
        readonly skipped: number;
        readonly timeSeconds: number;
    };
}

export interface CompilerErrorReport {
    readonly message: string;
    readonly details: string;
    readonly errorType: string;
    readonly reproductionSteps: string;
    readonly scenarioCode: string;
    readonly scenarioSettingsCode: string;
    readonly processCode: string;
    readonly processSettingsCode: string;
    readonly properties: Readonly<Record<string, string>>;
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
}

function readJson(content?: string | null): Record<string, unknown> | null {
    if (!content?.trim()) { return null; }
    try {
        return record(JSON.parse(content.replace(/^\uFEFF/u, '')));
    } catch {
        return null;
    }
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function integer(value: unknown, minimum: number): number | null {
    const candidate = typeof value === 'number' ? value
        : typeof value === 'string' && /^\d+$/u.test(value.trim()) ? Number(value) : Number.NaN;
    return Number.isSafeInteger(candidate) && candidate >= minimum ? candidate : null;
}

function boolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') { return value; }
    if (typeof value === 'string') {
        if (/^(?:true|истина)$/iu.test(value.trim())) { return true; }
        if (/^(?:false|ложь)$/iu.test(value.trim())) { return false; }
    }
    return undefined;
}

export function parseCompilerSourceMap(content?: string | null): CompilerSourceMap | null {
    const source = readJson(content);
    const rows = source?.ДанныеСценария ?? source?.ДанныеНомеровСтрок;
    if (!Array.isArray(rows)) { return null; }
    const entries: CompilerSourceMapEntry[] = [];
    for (const value of rows) {
        const row = record(value);
        if (!row) { continue; }
        const scenarioUid = text(row.UIDСценария);
        const featureLineNumber = integer(row.СтрокаЛин ?? row.НомерСтрокиЛинейногоСценария, 1);
        const sourceBodyLineNumber = integer(row.СтрокаОриг ?? row.НомерСтрокиТекстаСценария, 1);
        const nestingLevel = integer(row.УровеньВложенности ?? 0, 0);
        if (!scenarioUid || featureLineNumber === null || sourceBodyLineNumber === null || nestingLevel === null) {
            continue;
        }
        entries.push({
            scenarioUid,
            scenarioName: text(row.Имя ?? row.ИмяСценария),
            scenarioCode: text(row.Код ?? row.КодСценария),
            isMain: boolean(row.Основной) ?? nestingLevel === 0,
            stepText: text(row.ТекстШага), featureLineNumber, sourceBodyLineNumber, nestingLevel
        });
    }
    return { entries, mainScenarioUids: [...new Set(entries.filter(entry => entry.isMain).map(entry => entry.scenarioUid))] };
}

export function findCompilerSourceLocation(
    map: CompilerSourceMap | null | undefined, featureLineNumber: number
): CompilerSourceMapEntry | null {
    if (!Number.isSafeInteger(featureLineNumber) || featureLineNumber < 1) { return null; }
    const matches = map?.entries.filter(entry => entry.featureLineNumber === featureLineNumber) ?? [];
    const deepest = Math.max(...matches.map(entry => entry.nestingLevel));
    const candidates = matches.filter(entry => entry.nestingLevel === deepest);
    const selected = candidates[0];
    return selected && candidates.every(entry => entry.scenarioUid === selected.scenarioUid
        && entry.sourceBodyLineNumber === selected.sourceBodyLineNumber) ? selected : null;
}

function* featureStructuralLines(content?: string | null): Iterable<string> {
    let docStringDelimiter: string | undefined;
    for (const raw of (content ?? '').replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u)) {
        const line = raw.trim();
        const delimiter = line.match(/^("""|```)/u)?.[1];
        if (docStringDelimiter) {
            if (delimiter === docStringDelimiter) { docStringDelimiter = undefined; }
        } else if (delimiter) {
            docStringDelimiter = delimiter;
        } else {
            yield line;
        }
    }
}

export function extractCompilerFeatureScenarioNames(content?: string | null): readonly string[] {
    const names: string[] = [];
    for (const line of featureStructuralLines(content)) {
        const name = line.match(/^(?:Функционал|Функциональность|Свойство|Feature|Сценарий|Scenario)\s*:\s*(.+)$/iu)?.[1]?.trim();
        if (name) { names.push(name); }
    }
    return [...new Set(names)];
}

function featureTagValues(content: string | null | undefined, tags: readonly string[]): readonly string[] {
    const values: string[] = [];
    for (const line of featureStructuralLines(content)) {
        if (!line.startsWith('@')) { continue; }
        for (const match of line.matchAll(/(?:^|\s)@([^\s=@]+)=([^\s@]+)/gu)) {
            if (tags.includes(match[1])) { values.push(match[2]); }
        }
    }
    return [...new Set(values)];
}

export function extractCompilerFeatureScenarioUids(content?: string | null): readonly string[] {
    return featureTagValues(content, ['UIDСценария']);
}

export function extractCompilerFeatureProcessUids(content?: string | null): readonly string[] {
    return featureTagValues(content, ['UIDПроцесса']);
}

/** The root process header uses ПолныйКодПроцесса; КодПроцесса can identify nested steps. */
export function extractCompilerFeatureProcessCodes(content?: string | null): readonly string[] {
    return featureTagValues(content, ['ПолныйКодПроцесса']);
}

/** compile.txt is an inventory of attempted settings, including failed settings. */
export function parseCompileInventory(content?: string | null): CompilerCompileInventory | null {
    const source = readJson(content);
    if (!source || (!Array.isArray(source.scenario_tests) && !Array.isArray(source.process_tests))) { return null; }
    const codes = (values: unknown): string[] => Array.isArray(values)
        ? [...new Set(values.map(text).filter(Boolean))] : [];
    return { scenarioSettingsCodes: codes(source.scenario_tests), processSettingsCodes: codes(source.process_tests) };
}

interface XmlElement {
    readonly name: string;
    readonly attributes: Record<string, string>;
    readonly content: (string | XmlElement)[];
    readonly start: number;
    end: number;
}

function xmlName(value: string): boolean {
    return /^[\p{L}_][\p{L}\p{N}_.:-]*$/u.test(value);
}

function decodeXmlText(value: string): string {
    const named: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return value.replace(/&([^;\s<&]*);|&/gu, (match: string, entity: string | undefined) => {
        if (entity && Object.hasOwn(named, entity)) { return named[entity]; }
        const digits = entity?.match(/^#(x[\da-f]+|\d+)$/iu)?.[1];
        const code = digits ? Number.parseInt(digits.startsWith('x') || digits.startsWith('X') ? digits.slice(1) : digits,
            digits.startsWith('x') || digits.startsWith('X') ? 16 : 10) : 0;
        if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xD7FF)
            || (code >= 0xE000 && code <= 0xFFFD) || (code >= 0x10000 && code <= 0x10FFFF)) {
            return String.fromCodePoint(code);
        }
        throw new Error(`Invalid XML entity: ${match}`);
    });
}

/** Small strict XML reader for compiler reports; it never resolves DTDs or external entities. */
function readXml(content?: string | null): XmlElement | null {
    if (!content?.trim()) { return null; }
    const source = content.replace(/^\uFEFF/u, '');
    const document: XmlElement = { name: '', attributes: {}, content: [], start: 0, end: source.length };
    const stack = [document];
    const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^<>"']|"[^"<]*"|'[^'<]*')*>/gu;
    let offset = 0;
    try {
        for (const match of source.matchAll(tokens)) {
            const preceding = source.slice(offset, match.index);
            if (preceding.includes('<') || (stack.length === 1 && preceding.trim())) { return null; }
            stack[stack.length - 1].content.push(decodeXmlText(preceding));
            const token = match[0];
            offset = (match.index ?? 0) + token.length;
            if (token.startsWith('<!--') || token.startsWith('<?')) { continue; }
            if (token.startsWith('<![CDATA[')) {
                if (stack.length === 1) { return null; }
                stack[stack.length - 1].content.push(token.slice(9, -3));
                continue;
            }
            if (token.startsWith('<!')) { return null; }
            if (token.startsWith('</')) {
                const name = token.slice(2, -1).trim();
                if (stack.length === 1 || stack[stack.length - 1].name !== name) { return null; }
                const closing = stack.pop();
                if (closing) { closing.end = offset; }
                continue;
            }
            const selfClosing = token.endsWith('/>');
            const body = token.slice(1, selfClosing ? -2 : -1).trim();
            const name = body.match(/^\S+/u)?.[0] ?? '';
            if (!xmlName(name)) { return null; }
            const attributes: Record<string, string> = {};
            let attributeOffset = name.length;
            while (attributeOffset < body.length) {
                const whitespace = body.slice(attributeOffset).match(/^\s+/u)?.[0];
                if (!whitespace) { return null; }
                attributeOffset += whitespace.length;
                if (attributeOffset === body.length) { break; }
                const attribute = body.slice(attributeOffset).match(/^([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/u);
                if (!attribute || !xmlName(attribute[1]) || Object.hasOwn(attributes, attribute[1])) { return null; }
                Object.defineProperty(attributes, attribute[1], {
                    value: decodeXmlText(attribute[2] ?? attribute[3]), enumerable: true
                });
                attributeOffset += attribute[0].length;
            }
            const element: XmlElement = { name, attributes, content: [], start: match.index ?? 0, end: offset };
            stack[stack.length - 1].content.push(element);
            if (!selfClosing) { stack.push(element); }
        }
        if (stack.length !== 1 || source.slice(offset).trim()) { return null; }
        const roots = children(document);
        return roots.length === 1 ? roots[0] : null;
    } catch {
        return null;
    }
}

function localName(element: XmlElement): string {
    return element.name.split(':').pop() ?? element.name;
}

function children(element: XmlElement, name?: string): XmlElement[] {
    return element.content.filter((child): child is XmlElement => typeof child !== 'string'
        && (!name || localName(child) === name));
}

function descendants(element: XmlElement, name: string): XmlElement[] {
    const result: XmlElement[] = [];
    for (const child of children(element)) {
        if (localName(child) === name) { result.push(child); }
        result.push(...descendants(child, name));
    }
    return result;
}

function xmlText(element: XmlElement): string {
    return element.content.map(child => typeof child === 'string' ? child : xmlText(child)).join('');
}

function reportNumber(value: string | undefined): number | undefined {
    if (value === undefined || !/^\d+(?:\.\d+)?$/u.test(value.trim())) { return undefined; }
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function parseCompilerJUnit(content?: string | null): CompilerJUnitReport | null {
    const root = readXml(content);
    if (!root || !['testsuites', 'testsuite'].includes(localName(root))) { return null; }
    const suites = localName(root) === 'testsuite' ? [root, ...descendants(root, 'testsuite')]
        : descendants(root, 'testsuite');
    const entries: CompilerJUnitEntry[] = [];
    let failures = 0;
    let errors = 0;
    for (const suite of suites) {
        const properties = Object.fromEntries(children(suite, 'properties').flatMap(container => children(container, 'property'))
            .map(property => [property.attributes.name, property.attributes.value ?? xmlText(property)])
            .filter(([name]) => Boolean(name)));
        for (const testcase of children(suite, 'testcase')) {
            const failureElements = children(testcase, 'failure');
            const errorElements = children(testcase, 'error');
            const skippedElements = children(testcase, 'skipped');
            failures += failureElements.length;
            errors += errorElements.length;
            const diagnostics = [...errorElements, ...failureElements, ...skippedElements];
            entries.push({
                suiteName: suite.attributes.name ?? '', name: testcase.attributes.name ?? '',
                className: testcase.attributes.classname ?? '',
                status: errorElements.length ? 'error' : failureElements.length ? 'failed' : skippedElements.length ? 'skipped' : 'passed',
                timeSeconds: reportNumber(testcase.attributes.time) ?? 0,
                message: diagnostics.map(element => element.attributes.message ?? '').filter(Boolean).join('\n'),
                details: diagnostics.map(element => xmlText(element).trim()).filter(Boolean).join('\n'), properties
            });
        }
    }
    return {
        entries,
        summary: {
            tests: integer(root.attributes.tests, 0) ?? entries.length,
            failures: integer(root.attributes.failures, 0) ?? failures,
            errors: integer(root.attributes.errors, 0) ?? errors,
            skipped: integer(root.attributes.skipped, 0) ?? entries.filter(entry => entry.status === 'skipped').length,
            timeSeconds: reportNumber(root.attributes.time) ?? entries.reduce((sum, entry) => sum + entry.timeSeconds, 0)
        }
    };
}

/** Preserve compiler suite XML when combining worker reports, including inherited namespaces. */
export function extractCompilerJUnitSuitesXml(content?: string | null): readonly string[] | null {
    if (!parseCompilerJUnit(content)) { return null; }
    const root = readXml(content);
    if (!root || !content) { return null; }
    const source = content.replace(/^\uFEFF/u, '');
    const suites = localName(root) === 'testsuite' ? [root] : children(root, 'testsuite');
    return suites.map(suite => {
        const xml = source.slice(suite.start, suite.end);
        const inherited = Object.entries(root.attributes).filter(([name]) => (name === 'xmlns' || name.startsWith('xmlns:'))
            && !Object.hasOwn(suite.attributes, name));
        if (!inherited.length) { return xml; }
        const attributes = inherited.map(([name, value]) => ` ${name}="${value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;')
            .replace(/</gu, '&lt;')}"`).join('');
        return xml.replace(/^<([^\s/>]+)/u, `<$1${attributes}`);
    });
}

export function parseCompilerErrorXml(content?: string | null): CompilerErrorReport | null {
    const root = readXml(content);
    if (!root || !['Structure', 'Ошибка'].includes(localName(root))) { return null; }
    const properties = Object.fromEntries(children(root).map(property => {
        if (localName(property) === 'Property') {
            const value = children(property, 'Value')[0];
            return [property.attributes.name, value && !children(value).length ? xmlText(value).trim() : ''];
        }
        return [localName(property), xmlText(property).trim()];
    }).filter(([name]) => Boolean(name)));
    if (!['ТипОшибки', 'ИсходнаяИнформация', 'УточнениеРасположения', 'ПорядокВоспроизведения']
        .some(name => Object.hasOwn(properties, name))) { return null; }
    const locations = descendants(root, 'Property').filter(property => property.attributes.name === 'УточнениеРасположения')
        .map(property => xmlText(property).trim()).filter(Boolean);
    return {
        message: locations.join('\n') || properties.УточнениеРасположения || properties.ТипОшибки || '',
        details: properties.ИсходнаяИнформация || properties.ПорядокВоспроизведения || '',
        errorType: properties.ТипОшибки || '', reproductionSteps: properties.ПорядокВоспроизведения || '',
        scenarioCode: properties.КодСценария || '', scenarioSettingsCode: properties.КодНастройкиСценария || '',
        processCode: properties.КодПроцесса || '', processSettingsCode: properties.КодНастройкиПроцесса || '', properties
    };
}
