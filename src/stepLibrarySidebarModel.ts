import type {
    StepLibraryItem,
    StepLibrarySnapshot,
    StepLibrarySourceGroup
} from './stepLibraryModel';
import { buildCallableDefinitionText } from './projectDefinitionSnippet';

export interface StepLibrarySidebarNode {
    readonly id: string;
    readonly kind: 'source' | 'category' | 'definition' | 'more';
    readonly label: string;
    readonly count?: number;
    readonly depth: number;
    readonly expandable: boolean;
    readonly itemId?: string;
    readonly insertable?: boolean;
    readonly navigable?: boolean;
    readonly dragText?: string;
    readonly alternateLabel?: string;
    readonly scenarioKey?: string;
    readonly sourceGroup?: StepLibrarySourceGroup;
    readonly favorite?: boolean;
}

export interface StepLibrarySidebarPage {
    readonly parentId: string;
    readonly nodes: readonly StepLibrarySidebarNode[];
    readonly nextOffset: number | null;
}

interface CategoryBranch {
    readonly id: string;
    readonly label: string;
    readonly depth: number;
    readonly sourceGroup: StepLibrarySourceGroup;
    readonly childIds: string[];
    readonly directItems: StepLibraryItem[];
    count: number;
}

interface SearchEntry {
    readonly item: StepLibraryItem;
    readonly node: StepLibrarySidebarNode;
    readonly normalizedDisplay: string;
    readonly normalizedTemplate: string;
    readonly normalizedSearch: string;
    readonly displayWords: readonly string[];
}

const SOURCE_GROUPS: readonly StepLibrarySourceGroup[] = Object.freeze([
    'builtIn',
    'user',
    'export',
    'nested',
    'main'
]);

const SOURCE_LABELS: Readonly<Record<StepLibrarySourceGroup, string>> = Object.freeze({
    builtIn: 'Vanessa built-in steps',
    user: 'User steps',
    export: 'Export scenarios',
    nested: 'Nested scenarios',
    main: 'Main scenarios'
});

const DEFAULT_PAGE_SIZE = 100;
const MAX_SEARCH_RESULTS = 100;
const UNCATEGORIZED_KEY = '#uncategorized';
const UNCATEGORIZED_LABEL = 'Uncategorized';
const FAVORITES_ID = 'favorites';
const FAVORITES_LABEL = 'Favorites';

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeText(value: string): string {
    return value
        .normalize('NFC')
        .toLowerCase()
        .replace(/\s+/gu, ' ')
        .trim();
}

function normalizedLimit(value: number | undefined, fallback: number, maximum?: number): number {
    const finite = Number.isFinite(value) ? Math.floor(value!) : fallback;
    return Math.max(1, Math.min(finite, maximum ?? Number.MAX_SAFE_INTEGER));
}

function sourceId(group: StepLibrarySourceGroup): string {
    return `source:${group}`;
}

function categoryId(group: StepLibrarySourceGroup, path: readonly string[]): string {
    const encodedPath = path.length === 0
        ? UNCATEGORIZED_KEY
        : path.map(segment => encodeURIComponent(segment)).join('/');
    return `category:${group}:${encodedPath}`;
}

function buildDragText(item: StepLibraryItem, preferredLanguage: 'ru' | 'en'): string {
    if (item.sourceGroup !== 'nested' && item.sourceGroup !== 'export') {
        return item.displayText;
    }
    const fallbackKeyword = (item.language ?? preferredLanguage) === 'ru' ? 'И' : 'And';
    const callableText = buildCallableDefinitionText(item.displayText, '', fallbackKeyword);
    if (item.sourceGroup !== 'nested' || item.parameters.length === 0) {
        return callableText;
    }
    const maxNameLength = item.parameters.reduce((maximum, parameter) =>
        Math.max(maximum, parameter.name.length), 0);
    return item.parameters.reduce((text, parameter) => {
        const value = parameter.defaultValue ?? `"${parameter.name}"`;
        return `${text}\n    ${parameter.name.padEnd(maxNameLength, ' ')} = ${value}`;
    }, callableText);
}

function definitionNode(
    item: StepLibraryItem,
    depth: number,
    preferredLanguage: 'ru' | 'en',
    favoriteItemIds: ReadonlySet<string>
): StepLibrarySidebarNode {
    const scenarioKey = item.scenarioKey;
    return Object.freeze({
        id: `definition:${encodeURIComponent(item.id)}`,
        kind: 'definition' as const,
        label: item.displayText,
        depth,
        expandable: false,
        itemId: item.id,
        insertable: item.insertable,
        navigable: item.navigable,
        ...(item.insertable ? { dragText: buildDragText(item, preferredLanguage) } : {}),
        ...(item.alternateDisplayText ? { alternateLabel: item.alternateDisplayText } : {}),
        ...(scenarioKey ? { scenarioKey } : {}),
        sourceGroup: item.sourceGroup,
        favorite: favoriteItemIds.has(item.id)
    });
}

function stableItemOrder(left: StepLibraryItem, right: StepLibraryItem): number {
    return compareText(normalizeText(left.displayText), normalizeText(right.displayText))
        || compareText(left.id, right.id);
}

function selectBuiltInFamilies(
    items: readonly StepLibraryItem[],
    preferredLanguage: 'ru' | 'en'
): readonly StepLibraryItem[] {
    const families = new Map<string, StepLibraryItem[]>();
    const selected: StepLibraryItem[] = [];
    for (const item of items) {
        if (item.sourceGroup !== 'builtIn') {
            selected.push(item);
            continue;
        }
        const family = families.get(item.familyId) ?? [];
        family.push(item);
        families.set(item.familyId, family);
    }
    for (const family of families.values()) {
        family.sort(stableItemOrder);
        selected.push(family.find(item => item.language === preferredLanguage) ?? family[0]);
    }
    return Object.freeze(selected.sort((left, right) => {
        const sourceDifference = SOURCE_GROUPS.indexOf(left.sourceGroup) - SOURCE_GROUPS.indexOf(right.sourceGroup);
        return sourceDifference || stableItemOrder(left, right);
    }));
}

function searchRank(entry: SearchEntry, query: string, tokens: readonly string[]): number | null {
    if (!query) {
        return 0;
    }
    if (entry.normalizedDisplay === query) {
        return 0;
    }
    if (entry.normalizedDisplay.startsWith(query)) {
        return 1;
    }
    if (tokens.length > 0 && tokens.every(token =>
        entry.displayWords.some(word => word.startsWith(token))
    )) {
        return 2;
    }
    if (entry.normalizedDisplay.includes(query) || entry.normalizedTemplate.includes(query)) {
        return 3;
    }
    if (tokens.every(token => entry.normalizedSearch.includes(token))) {
        return 4;
    }
    return null;
}

export class StepLibrarySidebarIndex {
    private readonly rootNodes: readonly StepLibrarySidebarNode[];
    private readonly branches: ReadonlyMap<string, CategoryBranch>;
    private readonly itemsById: ReadonlyMap<string, StepLibraryItem>;
    private readonly ancestorIdsByItemId: ReadonlyMap<string, readonly string[]>;
    private readonly searchEntries: readonly SearchEntry[];
    private readonly favoriteItems: readonly StepLibraryItem[];

    private constructor(
        items: readonly StepLibraryItem[],
        private readonly preferredLanguage: 'ru' | 'en',
        private readonly favoriteItemIds: ReadonlySet<string>
    ) {
        const branches = new Map<string, CategoryBranch>();
        const itemsById = new Map<string, StepLibraryItem>();
        const ancestorIdsByItemId = new Map<string, readonly string[]>();
        const sourceCounts = new Map<StepLibrarySourceGroup, number>(SOURCE_GROUPS.map(group => [group, 0]));

        for (const group of SOURCE_GROUPS) {
            branches.set(sourceId(group), {
                id: sourceId(group),
                label: SOURCE_LABELS[group],
                depth: 0,
                sourceGroup: group,
                childIds: [],
                directItems: [],
                count: 0
            });
        }

        for (const item of items) {
            itemsById.set(item.id, item);
            sourceCounts.set(item.sourceGroup, (sourceCounts.get(item.sourceGroup) ?? 0) + 1);
            const source = branches.get(sourceId(item.sourceGroup))!;
            const categoryPath = item.categoryPath.map(segment => segment.trim()).filter(Boolean);
            const effectivePath = categoryPath.length > 0 ? categoryPath : [];
            let parent = source;
            const ancestorIds = [source.id];

            if (effectivePath.length === 0) {
                const uncategorizedId = categoryId(item.sourceGroup, []);
                let uncategorized = branches.get(uncategorizedId);
                if (!uncategorized) {
                    uncategorized = {
                        id: uncategorizedId,
                        label: UNCATEGORIZED_LABEL,
                        depth: 1,
                        sourceGroup: item.sourceGroup,
                        childIds: [],
                        directItems: [],
                        count: 0
                    };
                    branches.set(uncategorizedId, uncategorized);
                    source.childIds.push(uncategorizedId);
                }
                parent = uncategorized;
                ancestorIds.push(uncategorized.id);
            } else {
                for (let index = 0; index < effectivePath.length; index += 1) {
                    const path = effectivePath.slice(0, index + 1);
                    const id = categoryId(item.sourceGroup, path);
                    let branch = branches.get(id);
                    if (!branch) {
                        branch = {
                            id,
                            label: effectivePath[index],
                            depth: index + 1,
                            sourceGroup: item.sourceGroup,
                            childIds: [],
                            directItems: [],
                            count: 0
                        };
                        branches.set(id, branch);
                        parent.childIds.push(id);
                    }
                    parent = branch;
                    ancestorIds.push(branch.id);
                }
            }
            parent.directItems.push(item);
            ancestorIdsByItemId.set(item.id, Object.freeze(ancestorIds));
        }

        const branchCounts = (branch: CategoryBranch): number => {
            const total = branch.directItems.length + branch.childIds.reduce((sum, childId) =>
                sum + branchCounts(branches.get(childId)!), 0);
            branch.count = total;
            branch.directItems.sort(stableItemOrder);
            branch.childIds.sort((leftId, rightId) => {
                const left = branches.get(leftId)!;
                const right = branches.get(rightId)!;
                if (left.label === UNCATEGORIZED_LABEL) {
                    return right.label === UNCATEGORIZED_LABEL ? 0 : 1;
                }
                if (right.label === UNCATEGORIZED_LABEL) {
                    return -1;
                }
                return compareText(normalizeText(left.label), normalizeText(right.label))
                    || compareText(left.id, right.id);
            });
            return total;
        };
        for (const group of SOURCE_GROUPS) {
            branchCounts(branches.get(sourceId(group))!);
        }

        this.favoriteItems = Object.freeze(items
            .filter(item => favoriteItemIds.has(item.id))
            .sort(stableItemOrder));
        for (const item of this.favoriteItems) {
            const ancestors = new Set(ancestorIdsByItemId.get(item.id) ?? []);
            ancestors.add(FAVORITES_ID);
            ancestorIdsByItemId.set(item.id, Object.freeze([...ancestors]));
        }
        this.rootNodes = Object.freeze([
            Object.freeze({
                id: FAVORITES_ID,
                kind: 'source' as const,
                label: FAVORITES_LABEL,
                count: this.favoriteItems.length,
                depth: 0,
                expandable: this.favoriteItems.length > 0
            }),
            ...SOURCE_GROUPS.map(group => Object.freeze({
            id: sourceId(group),
            kind: 'source' as const,
            label: SOURCE_LABELS[group],
            count: sourceCounts.get(group) ?? 0,
            depth: 0,
            expandable: (sourceCounts.get(group) ?? 0) > 0,
            sourceGroup: group
            }))
        ]);
        this.branches = branches;
        this.itemsById = itemsById;
        this.ancestorIdsByItemId = ancestorIdsByItemId;
        this.searchEntries = Object.freeze(items.map(item => Object.freeze({
            item,
            node: definitionNode(item, 0, preferredLanguage, favoriteItemIds),
            normalizedDisplay: normalizeText(item.displayText),
            normalizedTemplate: normalizeText(item.template),
            normalizedSearch: normalizeText(item.searchText),
            displayWords: Object.freeze(normalizeText(item.displayText).split(/[^\p{L}\p{N}_]+/u).filter(Boolean))
        })));
    }

    public static fromSnapshot(
        snapshot: StepLibrarySnapshot,
        preferredLanguage: 'ru' | 'en',
        favoriteItemIds: ReadonlySet<string> = new Set()
    ): StepLibrarySidebarIndex {
        return new StepLibrarySidebarIndex(
            selectBuiltInFamilies(snapshot.items, preferredLanguage),
            preferredLanguage,
            favoriteItemIds
        );
    }

    public roots(): readonly StepLibrarySidebarNode[] {
        return this.rootNodes;
    }

    public children(parentId: string, offset = 0, limit = DEFAULT_PAGE_SIZE): StepLibrarySidebarPage {
        if (parentId === FAVORITES_ID) {
            const safeOffset = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));
            const safeLimit = normalizedLimit(limit, DEFAULT_PAGE_SIZE);
            const pageItems = this.favoriteItems.slice(safeOffset, safeOffset + safeLimit);
            const nodes = pageItems.map(item => definitionNode(
                item,
                1,
                this.preferredLanguage,
                this.favoriteItemIds
            ));
            const nextOffset = safeOffset + pageItems.length < this.favoriteItems.length
                ? safeOffset + pageItems.length
                : null;
            const moreNode: readonly StepLibrarySidebarNode[] = nextOffset === null
                ? []
                : [Object.freeze({
                    id: `${FAVORITES_ID}:more:${nextOffset}`,
                    kind: 'more' as const,
                    label: 'Show more…',
                    count: this.favoriteItems.length - nextOffset,
                    depth: 1,
                    expandable: false
                })];
            return Object.freeze({
                parentId,
                nodes: Object.freeze([...nodes, ...moreNode]),
                nextOffset
            });
        }
        const branch = this.branches.get(parentId);
        if (!branch) {
            return Object.freeze({ parentId, nodes: Object.freeze([]), nextOffset: null });
        }
        const safeOffset = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));
        const safeLimit = normalizedLimit(limit, DEFAULT_PAGE_SIZE);
        const categoryNodes = safeOffset === 0
            ? branch.childIds.map(childId => {
                const child = this.branches.get(childId)!;
                return Object.freeze({
                    id: child.id,
                    kind: 'category' as const,
                    label: child.label,
                    count: child.count,
                    depth: child.depth,
                    expandable: child.count > 0,
                    sourceGroup: child.sourceGroup
                });
            })
            : [];
        const directItems = branch.directItems.slice(safeOffset, safeOffset + safeLimit);
        const definitionNodes = directItems.map(item => definitionNode(
            item,
            branch.depth + 1,
            this.preferredLanguage,
            this.favoriteItemIds
        ));
        const nextOffset = safeOffset + directItems.length < branch.directItems.length
            ? safeOffset + directItems.length
            : null;
        const moreNode: readonly StepLibrarySidebarNode[] = nextOffset === null
            ? []
            : [Object.freeze({
                id: `${parentId}:more:${nextOffset}`,
                kind: 'more' as const,
                label: 'Show more…',
                count: branch.directItems.length - nextOffset,
                depth: branch.depth + 1,
                expandable: false,
                sourceGroup: branch.sourceGroup
            })];
        return Object.freeze({
            parentId,
            nodes: Object.freeze([...categoryNodes, ...definitionNodes, ...moreNode]),
            nextOffset
        });
    }

    public search(query: string, limit = MAX_SEARCH_RESULTS): readonly StepLibrarySidebarNode[] {
        const normalizedQuery = normalizeText(query);
        const tokens = normalizedQuery.split(/\s+/u).filter(Boolean);
        const safeLimit = normalizedLimit(limit, MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
        return Object.freeze(this.searchEntries
            .map(entry => ({ entry, rank: searchRank(entry, normalizedQuery, tokens) }))
            .filter((candidate): candidate is { entry: SearchEntry; rank: number } => candidate.rank !== null)
            .sort((left, right) => left.rank - right.rank || stableItemOrder(left.entry.item, right.entry.item))
            .slice(0, safeLimit)
            .map(candidate => candidate.entry.node));
    }

    public getItem(itemId: string): StepLibraryItem | undefined {
        return this.itemsById.get(itemId);
    }

    public ancestorIds(itemId: string): readonly string[] {
        return this.ancestorIdsByItemId.get(itemId) ?? Object.freeze([]);
    }
}
