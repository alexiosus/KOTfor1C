import { createHash } from 'node:crypto';

const VANESSA_VERSION_REGEX = /^\d+\.\d+\.\d+\.\d+$/;
const SHA1_REGEX = /^[0-9a-f]{40}$/;
const SHA256_REGEX = /^[0-9a-f]{64}$/;

export interface StepTextVariant {
    readonly pattern: string;
    readonly description: string;
}

export interface BuiltInStepDefinition {
    readonly id: string;
    readonly ru?: StepTextVariant;
    readonly en?: StepTextVariant;
}

export interface BuiltInStepCatalog {
    readonly schemaVersion: 1;
    readonly vanessaVersion: string;
    readonly generatedAt: string;
    readonly source: {
        readonly repository: 'Pr-Mex/vanessa-automation';
        readonly ref: string;
        readonly commit: string;
    };
    readonly steps: readonly BuiltInStepDefinition[];
}

export interface StepCatalogIndexEntry {
    readonly path: string;
    readonly sha256: string;
    readonly stepCount: number;
    readonly sourceCommit: string;
}

export interface StepCatalogIndex {
    readonly schemaVersion: 1;
    readonly generatedAt: string;
    readonly catalogs: Readonly<Record<string, StepCatalogIndexEntry>>;
}

export type ResolvedStepCatalogSource =
    | 'versioned-cache'
    | 'versioned-download'
    | 'custom-html'
    | 'bundled-html';

export interface ResolvedStepCatalog {
    readonly identity: string;
    readonly requestedVersion?: string;
    readonly catalogVersion: string;
    readonly source: ResolvedStepCatalogSource;
    readonly steps: readonly BuiltInStepDefinition[];
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): UnknownRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return value as UnknownRecord;
}

function asNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value;
}

function assertIsoTimestamp(value: unknown, label: string): string {
    const timestamp = asNonEmptyString(value, label);
    if (Number.isNaN(Date.parse(timestamp))) {
        throw new Error(`${label} must be an ISO timestamp.`);
    }
    return timestamp;
}

function assertVanessaVersion(value: unknown, label: string): string {
    const version = asNonEmptyString(value, label);
    if (!VANESSA_VERSION_REGEX.test(version)) {
        throw new Error(`${label} must be a four-component Vanessa version.`);
    }
    return version;
}

function assertHash(value: unknown, regex: RegExp, label: string): string {
    const hash = asNonEmptyString(value, label);
    if (!regex.test(hash)) {
        throw new Error(`${label} has an invalid hash format.`);
    }
    return hash;
}

export function normalizeStepCatalogText(value: string): string {
    return value
        .replace(/\r\n|\r/g, '\n')
        .trim()
        .normalize('NFC');
}

export function sha256Hex(value: string | Uint8Array): string {
    return createHash('sha256').update(value).digest('hex');
}

export function createStepDefinitionId(
    russianPattern: string | undefined,
    englishPattern: string | undefined
): string {
    const normalizedRussian = normalizeStepCatalogText(russianPattern || '');
    const normalizedEnglish = normalizeStepCatalogText(englishPattern || '');
    return sha256Hex(`${normalizedRussian}\0${normalizedEnglish}`);
}

function parseStepVariant(value: unknown, label: string): StepTextVariant | undefined {
    if (value === undefined) {
        return undefined;
    }

    const record = asRecord(value, label);
    const pattern = normalizeStepCatalogText(asNonEmptyString(record.pattern, `${label}.pattern`));
    const descriptionValue = record.description;
    if (typeof descriptionValue !== 'string') {
        throw new Error(`${label}.description must be a string.`);
    }
    return {
        pattern,
        description: normalizeStepCatalogText(descriptionValue)
    };
}

export function parseBuiltInStepCatalog(
    value: unknown,
    expectedVersion?: string
): BuiltInStepCatalog {
    const catalog = asRecord(value, 'Step catalog');
    if (catalog.schemaVersion !== 1) {
        throw new Error('Step catalog schemaVersion must be 1.');
    }

    const vanessaVersion = assertVanessaVersion(catalog.vanessaVersion, 'Step catalog Vanessa version');
    if (expectedVersion && vanessaVersion !== expectedVersion) {
        throw new Error(`Step catalog version ${vanessaVersion} does not match expected ${expectedVersion}.`);
    }

    const source = asRecord(catalog.source, 'Step catalog source');
    if (source.repository !== 'Pr-Mex/vanessa-automation') {
        throw new Error('Step catalog source repository must be Pr-Mex/vanessa-automation.');
    }
    const sourceRef = asNonEmptyString(source.ref, 'Step catalog source ref');
    const sourceCommit = assertHash(source.commit, SHA1_REGEX, 'Step catalog source commit');

    if (!Array.isArray(catalog.steps) || catalog.steps.length === 0) {
        throw new Error('Step catalog must contain at least one step.');
    }

    const ids = new Set<string>();
    const russianPatterns = new Set<string>();
    const englishPatterns = new Set<string>();
    const steps = catalog.steps.map((rawStep, index): BuiltInStepDefinition => {
        const step = asRecord(rawStep, `Step catalog step ${index}`);
        const ru = parseStepVariant(step.ru, `Step catalog step ${index}.ru`);
        const en = parseStepVariant(step.en, `Step catalog step ${index}.en`);
        if (!ru && !en) {
            throw new Error(`Step catalog step ${index} must contain a Russian or English variant.`);
        }

        const id = assertHash(step.id, SHA256_REGEX, `Step catalog step ${index} id`);
        const expectedId = createStepDefinitionId(ru?.pattern, en?.pattern);
        if (id !== expectedId) {
            throw new Error(`Step catalog step ${index} step id does not match its variants.`);
        }
        if (ids.has(id)) {
            throw new Error(`Step catalog contains duplicate step id ${id}.`);
        }
        ids.add(id);

        if (ru) {
            if (russianPatterns.has(ru.pattern)) {
                throw new Error(`Step catalog contains duplicate Russian pattern: ${ru.pattern}`);
            }
            russianPatterns.add(ru.pattern);
        }
        if (en) {
            if (englishPatterns.has(en.pattern)) {
                throw new Error(`Step catalog contains duplicate English pattern: ${en.pattern}`);
            }
            englishPatterns.add(en.pattern);
        }

        return { id, ru, en };
    });

    return {
        schemaVersion: 1,
        vanessaVersion,
        generatedAt: assertIsoTimestamp(catalog.generatedAt, 'Step catalog generatedAt'),
        source: {
            repository: 'Pr-Mex/vanessa-automation',
            ref: sourceRef,
            commit: sourceCommit
        },
        steps
    };
}

function assertSafeRelativeCatalogPath(value: unknown): string {
    const catalogPath = asNonEmptyString(value, 'Catalog index entry path');
    const segments = catalogPath.split('/');
    if (
        catalogPath.includes('\\')
        || catalogPath.startsWith('/')
        || catalogPath.includes('?')
        || catalogPath.includes('#')
        || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')
    ) {
        throw new Error('Catalog index entry path must be a safe relative path.');
    }
    return catalogPath;
}

export function parseStepCatalogIndex(value: unknown): StepCatalogIndex {
    const index = asRecord(value, 'Step catalog index');
    if (index.schemaVersion !== 1) {
        throw new Error('Step catalog index schemaVersion must be 1.');
    }

    const rawCatalogs = asRecord(index.catalogs, 'Step catalog index catalogs');
    const catalogs: Record<string, StepCatalogIndexEntry> = {};
    for (const [rawVersion, rawEntry] of Object.entries(rawCatalogs)) {
        const version = assertVanessaVersion(rawVersion, 'Catalog index Vanessa version');
        const entry = asRecord(rawEntry, `Catalog index entry ${version}`);
        if (!Number.isInteger(entry.stepCount) || (entry.stepCount as number) <= 0) {
            throw new Error(`Catalog index entry ${version} stepCount must be a positive integer.`);
        }
        catalogs[version] = {
            path: assertSafeRelativeCatalogPath(entry.path),
            sha256: assertHash(entry.sha256, SHA256_REGEX, `Catalog index entry ${version} sha256`),
            stepCount: entry.stepCount as number,
            sourceCommit: assertHash(
                entry.sourceCommit,
                SHA1_REGEX,
                `Catalog index entry ${version} sourceCommit`
            )
        };
    }

    return {
        schemaVersion: 1,
        generatedAt: assertIsoTimestamp(index.generatedAt, 'Step catalog index generatedAt'),
        catalogs
    };
}
