import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    FormExplorerAttributeInfo,
    FormExplorerElementInfo,
    FormExplorerSnapshot
} from './formExplorerTypes';

interface FormsIndexFile {
    configuration?: {
        selectedLanguage?: {
            code?: string;
        };
        sourceDirectory?: string;
    };
    managedForms?: StaticManagedFormRecord[];
}

interface StaticManagedFormRecord {
    metadataPath: string;
    rootDirectoryName: string;
    objectType: string;
    objectName: string;
    formName: string;
    title?: string;
    sourceLayoutXmlPath?: string;
    sourceObjectXmlPath?: string | null;
    sourceModulePath?: string | null;
}

interface StaticFormElementMetadata {
    tailPath: string;
    name: string;
    tagName: string;
    title?: string;
    toolTip?: string;
    inputHint?: string;
    dataPath?: string;
    titleDataPath?: string;
    sourcePath?: string;
    sourceLine?: number;
    sourceColumn?: number;
}

interface StaticFormMetadata {
    formTitle?: string;
    layoutPath?: string;
    objectPath?: string | null;
    modulePath?: string | null;
    attributeLabelsByPath: Map<string, string>;
    elementsByTailPath: Map<string, StaticFormElementMetadata>;
}

interface XmlNode {
    tagName: string;
    attributes: Record<string, string>;
    children: XmlNode[];
    textParts: string[];
}

const formsIndexCache = new Map<string, Promise<FormsIndexFile | null>>();
const formMetadataCache = new Map<string, Promise<StaticFormMetadata | null>>();

function decodeXmlEntities(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, '\'')
        .replace(/&amp;/g, '&');
}

function xmlLocalName(tagName: string): string {
    const parts = tagName.split(':');
    return parts[parts.length - 1] || tagName;
}

function isAbsolutePathLike(candidatePath: string): boolean {
    return path.isAbsolute(candidatePath) || /^[a-zA-Z]:[\\/]/.test(candidatePath);
}

function stripBom(text: string): string {
    return text.replace(/^\uFEFF/, '');
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
    if (Array.isArray(value)) {
        return value;
    }
    return value === undefined || value === null ? [] : [value];
}

function normalizeText(value: string | undefined | null): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = decodeXmlEntities(value).replace(/\s+/g, ' ').trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function lastSegment(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    const parts = value.split('.');
    return parts[parts.length - 1] || undefined;
}

function humanizeIdentifier(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }

    const cleaned = value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return cleaned.length > 0 ? cleaned : undefined;
}

function elementTailPath(fullPath: string | undefined): string | undefined {
    if (!fullPath) {
        return undefined;
    }

    const segments = fullPath.split('.');
    if (segments.length <= 1) {
        return fullPath;
    }

    return segments.slice(1).join('.');
}

function parseAttributes(rawAttributes: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    const attributePattern = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
    for (const match of rawAttributes.matchAll(attributePattern)) {
        attributes[match[1]] = decodeXmlEntities(match[2] || '');
    }
    return attributes;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function indexToLineColumn(text: string, index: number): { line: number; column: number } {
    const prefix = text.slice(0, Math.max(0, index));
    const lineBreaks = prefix.match(/\r\n|\r|\n/g);
    const line = (lineBreaks?.length || 0) + 1;
    const lastLineBreakIndex = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r'));
    const column = index - lastLineBreakIndex;
    return { line, column };
}

function findElementSourceLocation(
    xmlText: string,
    tagName: string,
    name: string | undefined,
    id: string | undefined
): { line: number; column: number } | undefined {
    if (!name) {
        return undefined;
    }

    const tagPattern = escapeRegExp(tagName);
    const namePattern = escapeRegExp(name);
    const idPattern = id ? escapeRegExp(id) : undefined;
    const patterns = [
        idPattern
            ? new RegExp(`<${tagPattern}\\b[^>]*\\bname="${namePattern}"[^>]*\\bid="${idPattern}"[^>]*>`, 'i')
            : undefined,
        new RegExp(`<${tagPattern}\\b[^>]*\\bname="${namePattern}"[^>]*>`, 'i')
    ].filter((pattern): pattern is RegExp => Boolean(pattern));

    for (const pattern of patterns) {
        const match = pattern.exec(xmlText);
        if (match && typeof match.index === 'number') {
            return indexToLineColumn(xmlText, match.index);
        }
    }

    return undefined;
}

function parseXml(xmlText: string): XmlNode | null {
    const sanitized = stripBom(xmlText);
    const tokenPattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/[^>]+>|<[^>]+>|[^<]+/g;
    const root: XmlNode = {
        tagName: '#document',
        attributes: {},
        children: [],
        textParts: []
    };
    const stack: XmlNode[] = [root];

    for (const match of sanitized.matchAll(tokenPattern)) {
        const token = match[0];
        if (!token) {
            continue;
        }

        if (token.startsWith('<!--') || token.startsWith('<?') || token.startsWith('<!DOCTYPE')) {
            continue;
        }

        if (token.startsWith('<![CDATA[')) {
            stack[stack.length - 1]?.textParts.push(token.slice(9, -3));
            continue;
        }

        if (token.startsWith('</')) {
            if (stack.length > 1) {
                stack.pop();
            }
            continue;
        }

        if (token.startsWith('<')) {
            const inner = token.slice(1, token.length - 1).trim();
            const selfClosing = inner.endsWith('/');
            const trimmed = selfClosing ? inner.slice(0, -1).trim() : inner;
            const tagNameMatch = /^([A-Za-z_][\w:.-]*)/.exec(trimmed);
            if (!tagNameMatch) {
                continue;
            }

            const tagName = tagNameMatch[1];
            const rawAttributes = trimmed.slice(tagName.length).trim();
            const node: XmlNode = {
                tagName,
                attributes: parseAttributes(rawAttributes),
                children: [],
                textParts: []
            };

            stack[stack.length - 1]?.children.push(node);
            if (!selfClosing) {
                stack.push(node);
            }
            continue;
        }

        stack[stack.length - 1]?.textParts.push(token);
    }

    return root.children[0] || null;
}

function findFirstNode(node: XmlNode | null, localName: string): XmlNode | null {
    if (!node) {
        return null;
    }

    if (xmlLocalName(node.tagName) === localName) {
        return node;
    }

    for (const child of node.children) {
        const found = findFirstNode(child, localName);
        if (found) {
            return found;
        }
    }

    return null;
}

function getChildNodes(node: XmlNode | null, localName: string): XmlNode[] {
    if (!node) {
        return [];
    }

    return node.children.filter(child => xmlLocalName(child.tagName) === localName);
}

function getFirstChildNode(node: XmlNode | null, localName: string): XmlNode | undefined {
    return getChildNodes(node, localName)[0];
}

function getNodeText(node: XmlNode | null | undefined): string | undefined {
    if (!node) {
        return undefined;
    }

    const combined = [
        ...node.textParts,
        ...node.children.map(child => getNodeText(child) || '')
    ].join('');

    return normalizeText(combined);
}

function getLocalizedNodeText(node: XmlNode | null | undefined, preferredLanguageCode: string | undefined): string | undefined {
    if (!node) {
        return undefined;
    }

    const items = getChildNodes(node, 'item');
    if (items.length === 0) {
        return getNodeText(node);
    }

    const preferredLang = (preferredLanguageCode || '').toLowerCase();
    let fallback: string | undefined;

    for (const item of items) {
        const language = (getNodeText(getFirstChildNode(item, 'lang')) || '').toLowerCase();
        const content = getNodeText(getFirstChildNode(item, 'content'));
        if (!content) {
            continue;
        }

        if (!fallback) {
            fallback = content;
        }

        if (preferredLang && language === preferredLang) {
            return content;
        }
    }

    return fallback;
}

function chooseStaticLabel(metadata: StaticFormElementMetadata, fallbackName: string | undefined): string | undefined {
    return normalizeText(metadata.title)
        || normalizeText(metadata.toolTip)
        || normalizeText(metadata.inputHint)
        || humanizeIdentifier(lastSegment(metadata.dataPath))
        || humanizeIdentifier(fallbackName);
}

function getPropertyNode(node: XmlNode | null | undefined, propertyName: string): XmlNode | undefined {
    const propertiesNode = getFirstChildNode(node || null, 'Properties');
    return getFirstChildNode(propertiesNode, propertyName);
}

function getPropertyText(node: XmlNode | null | undefined, propertyName: string): string | undefined {
    return getNodeText(getPropertyNode(node, propertyName));
}

function getLocalizedPropertyText(
    node: XmlNode | null | undefined,
    propertyName: string,
    preferredLanguageCode: string | undefined
): string | undefined {
    return getLocalizedNodeText(getPropertyNode(node, propertyName), preferredLanguageCode);
}

function extractXmlInnerText(fragment: string | undefined): string | undefined {
    if (!fragment) {
        return undefined;
    }

    return normalizeText(fragment.replace(/<[^>]+>/g, ' '));
}

function extractSimplePropertyValue(propertiesXml: string, propertyName: string): string | undefined {
    const pattern = new RegExp(`<${propertyName}>([\\s\\S]*?)</${propertyName}>`, 'i');
    const match = pattern.exec(propertiesXml);
    return extractXmlInnerText(match?.[1]);
}

function extractLocalizedPropertyValue(propertiesXml: string, propertyName: string, preferredLanguageCode: string | undefined): string | undefined {
    const pattern = new RegExp(`<${propertyName}>([\\s\\S]*?)</${propertyName}>`, 'i');
    const match = pattern.exec(propertiesXml);
    const body = match?.[1];
    if (!body) {
        return undefined;
    }

    const itemPattern = /<(?:[\w-]+:)?item\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?item>/gi;
    const preferredLang = (preferredLanguageCode || '').toLowerCase();
    let fallback: string | undefined;

    for (const itemMatch of body.matchAll(itemPattern)) {
        const itemBody = itemMatch[1];
        const lang = extractXmlInnerText((/<(?:[\w-]+:)?lang\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?lang>/i.exec(itemBody || '') || [])[1]) || '';
        const content = extractXmlInnerText((/<(?:[\w-]+:)?content\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?content>/i.exec(itemBody || '') || [])[1]);
        if (!content) {
            continue;
        }

        if (!fallback) {
            fallback = content;
        }

        if (preferredLang && lang.toLowerCase() === preferredLang) {
            return content;
        }
    }

    return fallback || extractXmlInnerText(body);
}

function collectObjectAttributeLabels(
    node: XmlNode | null | undefined,
    preferredLanguageCode: string | undefined,
    pathPrefix: string | undefined,
    result: Map<string, string>
): void {
    if (!node) {
        return;
    }

    for (const child of node.children) {
        const localName = xmlLocalName(child.tagName);

        if (localName === 'Attribute' || localName === 'StandardAttribute') {
            const name = normalizeText(getPropertyText(child, 'Name'));
            if (!name) {
                collectObjectAttributeLabels(child, preferredLanguageCode, pathPrefix, result);
                continue;
            }

            const label = normalizeText(getLocalizedPropertyText(child, 'Synonym', preferredLanguageCode))
                || humanizeIdentifier(name);
            const relativePath = pathPrefix ? `${pathPrefix}.${name}` : name;
            if (label) {
                result.set(relativePath, label);
                result.set(`Object.${relativePath}`, label);
            }
            collectObjectAttributeLabels(child, preferredLanguageCode, relativePath, result);
            continue;
        }

        if (localName === 'TabularSection') {
            const name = normalizeText(getPropertyText(child, 'Name'));
            if (!name) {
                collectObjectAttributeLabels(child, preferredLanguageCode, pathPrefix, result);
                continue;
            }

            const nextPrefix = pathPrefix ? `${pathPrefix}.${name}` : name;
            const label = normalizeText(getLocalizedPropertyText(child, 'Synonym', preferredLanguageCode))
                || humanizeIdentifier(name);
            if (label) {
                result.set(nextPrefix, label);
                result.set(`Object.${nextPrefix}`, label);
            }

            collectObjectAttributeLabels(child, preferredLanguageCode, nextPrefix, result);
            continue;
        }

        collectObjectAttributeLabels(child, preferredLanguageCode, pathPrefix, result);
    }
}

function supplementObjectAttributeLabelsFromRawXml(
    xmlText: string,
    preferredLanguageCode: string | undefined,
    result: Map<string, string>
): void {
    const blockPattern = /<(Attribute|StandardAttribute|TabularSection)\b[\s\S]*?<Properties>([\s\S]*?)<\/Properties>[\s\S]*?<\/\1>/gi;

    for (const match of xmlText.matchAll(blockPattern)) {
        const propertiesXml = match[2] || '';
        const name = extractSimplePropertyValue(propertiesXml, 'Name');
        if (!name) {
            continue;
        }

        const label = extractLocalizedPropertyValue(propertiesXml, 'Synonym', preferredLanguageCode)
            || humanizeIdentifier(name);
        if (!label) {
            continue;
        }

        result.set(name, label);
        result.set(`Object.${name}`, label);
    }
}

function resolveAttributeLabel(
    attributeLabelsByPath: Map<string, string>,
    boundAttributePath: string | undefined
): string | undefined {
    const normalizedPath = normalizeText(boundAttributePath);
    if (!normalizedPath) {
        return undefined;
    }

    const candidates = [
        normalizedPath,
        normalizedPath.replace(/^ThisObject\./, 'Object.'),
        normalizedPath.replace(/^Object\./, ''),
        lastSegment(normalizedPath)
    ].filter((candidate, index, items): candidate is string =>
        Boolean(candidate) && items.indexOf(candidate) === index
    );

    for (const candidate of candidates) {
        const label = attributeLabelsByPath.get(candidate);
        if (label) {
            return label;
        }
    }

    return undefined;
}

function inferAttributePath(
    attributeLabelsByPath: Map<string, string>,
    elementName: string | undefined
): string | undefined {
    const normalizedName = normalizeText(elementName);
    if (!normalizedName) {
        return undefined;
    }

    const candidates = [
        `Object.${normalizedName}`,
        normalizedName
    ];

    for (const candidate of candidates) {
        if (attributeLabelsByPath.has(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

function resolveCandidatePath(candidatePath: string | undefined, fallbackPath: string | undefined): string | undefined {
    if (candidatePath && isAbsolutePathLike(candidatePath)) {
        return candidatePath;
    }

    if (!candidatePath || !fallbackPath) {
        return candidatePath;
    }

    return path.join(fallbackPath, candidatePath);
}

async function pathExists(candidatePath: string | undefined): Promise<boolean> {
    if (!candidatePath) {
        return false;
    }

    try {
        await fs.promises.access(candidatePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function buildLayoutPath(baseDirectory: string | undefined, descriptor: StaticManagedFormRecord): string | undefined {
    if (!baseDirectory) {
        return undefined;
    }

    if (descriptor.rootDirectoryName === 'CommonForms') {
        return path.join(baseDirectory, 'CommonForms', descriptor.formName, 'Ext', 'Form.xml');
    }

    return path.join(
        baseDirectory,
        descriptor.rootDirectoryName,
        descriptor.objectName,
        'Forms',
        descriptor.formName,
        'Ext',
        'Form.xml'
    );
}

function buildModulePath(baseDirectory: string | undefined, descriptor: StaticManagedFormRecord): string | undefined {
    if (!baseDirectory) {
        return undefined;
    }

    if (descriptor.rootDirectoryName === 'CommonForms') {
        return path.join(baseDirectory, 'CommonForms', descriptor.formName, 'Ext', 'Form', 'Module.bsl');
    }

    return path.join(
        baseDirectory,
        descriptor.rootDirectoryName,
        descriptor.objectName,
        'Forms',
        descriptor.formName,
        'Ext',
        'Form',
        'Module.bsl'
    );
}

async function loadFormsIndex(formsIndexPath: string): Promise<FormsIndexFile | null> {
    let cached = formsIndexCache.get(formsIndexPath);
    if (!cached) {
        cached = (async () => {
            try {
                const text = await fs.promises.readFile(formsIndexPath, 'utf8');
                return JSON.parse(stripBom(text)) as FormsIndexFile;
            } catch {
                return null;
            }
        })();
        formsIndexCache.set(formsIndexPath, cached);
    }

    return cached;
}

function collectStaticElements(
    node: XmlNode,
    preferredLanguageCode: string | undefined,
    xmlText: string,
    sourcePath: string | undefined,
    parentTailPath: string | undefined,
    result: Map<string, StaticFormElementMetadata>
): void {
    for (const child of node.children) {
        const childLocalName = xmlLocalName(child.tagName);
        const childName = child.attributes.name;

        if (childName) {
            const tailPath = parentTailPath ? `${parentTailPath}.${childName}` : childName;
            const sourceLocation = findElementSourceLocation(xmlText, childLocalName, childName, child.attributes.id);
            result.set(tailPath, {
                tailPath,
                name: childName,
                tagName: childLocalName,
                title: getLocalizedNodeText(getFirstChildNode(child, 'Title'), preferredLanguageCode),
                toolTip: getLocalizedNodeText(getFirstChildNode(child, 'ToolTip'), preferredLanguageCode),
                inputHint: getLocalizedNodeText(getFirstChildNode(child, 'InputHint'), preferredLanguageCode),
                dataPath: getNodeText(getFirstChildNode(child, 'DataPath')),
                titleDataPath: getNodeText(getFirstChildNode(child, 'TitleDataPath')),
                sourcePath,
                sourceLine: sourceLocation?.line,
                sourceColumn: sourceLocation?.column
            });

            collectStaticElements(child, preferredLanguageCode, xmlText, sourcePath, tailPath, result);
            continue;
        }

        if (childLocalName === 'ChildItems' || childLocalName === 'ContextMenu') {
            collectStaticElements(child, preferredLanguageCode, xmlText, sourcePath, parentTailPath, result);
        }
    }
}

async function loadStaticFormMetadata(
    descriptor: StaticManagedFormRecord,
    preferredLanguageCode: string | undefined,
    configurationSourceDirectory: string | undefined
): Promise<StaticFormMetadata | null> {
    const cacheKey = [
        descriptor.metadataPath,
        preferredLanguageCode || '',
        configurationSourceDirectory || ''
    ].join('|');

    let cached = formMetadataCache.get(cacheKey);
    if (!cached) {
        cached = (async () => {
            const layoutPathCandidates = [
                descriptor.sourceLayoutXmlPath,
                buildLayoutPath(configurationSourceDirectory, descriptor)
            ].filter((candidate): candidate is string => Boolean(candidate));

            let resolvedLayoutPath: string | undefined;
            for (const candidate of layoutPathCandidates) {
                if (await pathExists(candidate)) {
                    resolvedLayoutPath = candidate;
                    break;
                }
            }

            if (!resolvedLayoutPath) {
                return null;
            }

            const modulePathCandidates = [
                descriptor.sourceModulePath || undefined,
                buildModulePath(configurationSourceDirectory, descriptor)
            ].filter((candidate): candidate is string => Boolean(candidate));

            let resolvedModulePath: string | undefined;
            for (const candidate of modulePathCandidates) {
                if (await pathExists(candidate)) {
                    resolvedModulePath = candidate;
                    break;
                }
            }

            const objectPathCandidates = [
                descriptor.sourceObjectXmlPath || undefined,
                configurationSourceDirectory && descriptor.rootDirectoryName !== 'CommonForms'
                    ? path.join(configurationSourceDirectory, descriptor.rootDirectoryName, `${descriptor.objectName}.xml`)
                    : undefined
            ].filter((candidate): candidate is string => Boolean(candidate));

            let resolvedObjectPath: string | undefined;
            for (const candidate of objectPathCandidates) {
                if (await pathExists(candidate)) {
                    resolvedObjectPath = candidate;
                    break;
                }
            }

            const xmlText = await fs.promises.readFile(resolvedLayoutPath, 'utf8');
            const root = parseXml(xmlText);
            const formNode = findFirstNode(root, 'Form');
            if (!formNode) {
                return null;
            }

            const elementsByTailPath = new Map<string, StaticFormElementMetadata>();
            collectStaticElements(formNode, preferredLanguageCode, xmlText, resolvedLayoutPath, undefined, elementsByTailPath);

            const attributeLabelsByPath = new Map<string, string>();
            if (resolvedObjectPath) {
                const objectXmlText = await fs.promises.readFile(resolvedObjectPath, 'utf8');
                const objectRoot = parseXml(objectXmlText);
                collectObjectAttributeLabels(objectRoot, preferredLanguageCode, undefined, attributeLabelsByPath);
                supplementObjectAttributeLabelsFromRawXml(objectXmlText, preferredLanguageCode, attributeLabelsByPath);
            }

            return {
                formTitle: normalizeText(descriptor.title),
                layoutPath: resolvedLayoutPath,
                objectPath: resolvedObjectPath ?? null,
                modulePath: resolvedModulePath ?? null,
                attributeLabelsByPath,
                elementsByTailPath
            };
        })();
        formMetadataCache.set(cacheKey, cached);
    }

    return cached;
}

function buildAttributeFromElement(element: FormExplorerElementInfo): FormExplorerAttributeInfo | null {
    const attributePath = normalizeText(element.boundAttributePath);
    if (!attributePath) {
        return null;
    }

    const title = normalizeText(element.title)
        || normalizeText(element.synonym)
        || humanizeIdentifier(lastSegment(attributePath))
        || humanizeIdentifier(element.name);

    return {
        path: attributePath,
        name: lastSegment(attributePath) || attributePath,
        title,
        synonym: normalizeText(element.synonym) || title,
        type: undefined,
        valuePreview: normalizeText(element.valuePreview),
        visible: element.visible,
        available: element.available,
        readOnly: element.readOnly,
        required: undefined,
        metadataPath: undefined,
        source: element.source
    };
}

function enrichElementTree(
    elements: FormExplorerElementInfo[],
    staticMetadata: StaticFormMetadata | null
): FormExplorerElementInfo[] {
    return elements.map(element => {
        const tailPath = elementTailPath(element.path);
        const staticElement = tailPath ? staticMetadata?.elementsByTailPath.get(tailPath) : undefined;
        const attributeLabelsByPath = staticMetadata?.attributeLabelsByPath || new Map<string, string>();
        const boundAttributePath = normalizeText(element.boundAttributePath)
            || normalizeText(staticElement?.dataPath)
            || normalizeText(staticElement?.titleDataPath)
            || inferAttributePath(attributeLabelsByPath, element.name);
        const attributeLabel = resolveAttributeLabel(attributeLabelsByPath, boundAttributePath)
            || resolveAttributeLabel(attributeLabelsByPath, element.name)
            || resolveAttributeLabel(attributeLabelsByPath, element.path);
        const runtimeTitle = normalizeText(element.title);
        const runtimeSynonym = normalizeText(element.synonym);
        const staticTitle = staticElement
            ? normalizeText(staticElement.title) || chooseStaticLabel(staticElement, element.name)
            : undefined;
        const title = runtimeTitle
            || runtimeSynonym
            || attributeLabel
            || staticTitle
            || humanizeIdentifier(lastSegment(boundAttributePath))
            || humanizeIdentifier(element.name);
        const synonym = runtimeSynonym
            || runtimeTitle
            || attributeLabel
            || staticTitle
            || title;
        const valuePreview = normalizeText(element.valuePreview);

        return {
            ...element,
            title,
            synonym,
            toolTip: normalizeText(element.toolTip) || normalizeText(staticElement?.toolTip),
            inputHint: normalizeText(element.inputHint) || normalizeText(staticElement?.inputHint),
            titleDataPath: normalizeText(element.titleDataPath) || normalizeText(staticElement?.titleDataPath),
            boundAttributePath: boundAttributePath || undefined,
            valuePreview: valuePreview || undefined,
            source: element.source || (staticElement?.sourcePath
                ? {
                    path: staticElement.sourcePath,
                    line: staticElement.sourceLine,
                    column: staticElement.sourceColumn
                }
                : undefined),
            children: enrichElementTree(element.children, staticMetadata)
        };
    });
}

function mergeAttributes(
    snapshot: FormExplorerSnapshot,
    enrichedElements: FormExplorerElementInfo[]
): FormExplorerAttributeInfo[] {
    const attributeMap = new Map<string, FormExplorerAttributeInfo>();

    for (const attribute of snapshot.attributes) {
        attributeMap.set(attribute.path, { ...attribute });
    }

    const collectFromElements = (elements: FormExplorerElementInfo[]): void => {
        for (const element of elements) {
            const derived = buildAttributeFromElement(element);
            if (derived) {
                const existing = attributeMap.get(derived.path);
                attributeMap.set(derived.path, existing ? {
                    ...existing,
                    title: existing.title || derived.title,
                    synonym: existing.synonym || derived.synonym,
                    valuePreview: existing.valuePreview || derived.valuePreview,
                    source: existing.source || derived.source
                } : derived);
            }

            collectFromElements(element.children);
        }
    };

    collectFromElements(enrichedElements);
    return [...attributeMap.values()];
}

function backfillElementValues(
    elements: FormExplorerElementInfo[],
    attributesByPath: Map<string, FormExplorerAttributeInfo>
): FormExplorerElementInfo[] {
    return elements.map(element => {
        const boundPath = normalizeText(element.boundAttributePath);
        const linkedAttribute = boundPath ? attributesByPath.get(boundPath) : undefined;

        return {
            ...element,
            valuePreview: normalizeText(element.valuePreview) || linkedAttribute?.valuePreview,
            children: backfillElementValues(element.children, attributesByPath)
        };
    });
}

export async function enrichFormExplorerSnapshot(
    snapshot: FormExplorerSnapshot,
    snapshotPath: string | null
): Promise<FormExplorerSnapshot> {
    const metadataPath = normalizeText(snapshot.form.metadataPath) || normalizeText(snapshot.form.name);
    if (!metadataPath || !snapshotPath) {
        return snapshot;
    }

    const formsIndexPath = path.join(path.dirname(snapshotPath), 'forms-index.json');
    if (!(await pathExists(formsIndexPath))) {
        return snapshot;
    }

    const formsIndex = await loadFormsIndex(formsIndexPath);
    const descriptor = asArray(formsIndex?.managedForms).find(form => form.metadataPath === metadataPath);
    if (!descriptor) {
        return snapshot;
    }

    const configurationSourceDirectory = normalizeText(snapshot.source?.configurationSourceDirectory)
        || normalizeText(formsIndex?.configuration?.sourceDirectory);
    const preferredLanguageCode = normalizeText(formsIndex?.configuration?.selectedLanguage?.code);
    const staticMetadata = await loadStaticFormMetadata(descriptor, preferredLanguageCode, configurationSourceDirectory);
    if (!staticMetadata) {
        return snapshot;
    }

    const enrichedElements = enrichElementTree(snapshot.elements, staticMetadata);
    const mergedAttributes = mergeAttributes(snapshot, enrichedElements);
    const attributesByPath = new Map(mergedAttributes.map(attribute => [attribute.path, attribute] as const));
    const elementsWithValues = backfillElementValues(enrichedElements, attributesByPath);

    return {
        ...snapshot,
        form: {
            ...snapshot.form,
            title: normalizeText(snapshot.form.windowTitle)
                || normalizeText(snapshot.form.title)
                || staticMetadata.formTitle
                || humanizeIdentifier(lastSegment(snapshot.form.metadataPath))
                || snapshot.form.title,
            windowTitle: normalizeText(snapshot.form.windowTitle)
                || normalizeText(snapshot.form.title)
                || staticMetadata.formTitle
                || snapshot.form.windowTitle,
            source: snapshot.form.source || (staticMetadata.layoutPath ? {
                path: staticMetadata.layoutPath,
                line: 1,
                column: 1
            } : undefined)
        },
        elements: elementsWithValues,
        tables: snapshot.tables,
        attributes: mergedAttributes
    };
}
