(function attachStepLibraryProtocol(root, factory) {
    'use strict';
    const protocol = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = protocol;
    }
    root.StepLibraryProtocol = protocol;
}(typeof globalThis === 'object' ? globalThis : this, function createStepLibraryProtocol() {
    'use strict';

    const SOURCE_ORDER = ['builtIn', 'user', 'export', 'nested', 'main'];
    const DEFAULT_SOURCE_LABELS = Object.freeze({
        builtIn: 'Vanessa',
        user: 'User steps',
        export: 'Export scenarios',
        nested: 'Nested scenarios',
        main: 'Main scenarios'
    });
    const DEFAULT_RESULT_LIMIT = 100;
    const UNCATEGORIZED_SENTINEL = '#uncategorized';

    function normalize(value) {
        return String(value || '')
            .normalize('NFC')
            .toLowerCase()
            .replace(/\s+/gu, ' ')
            .trim();
    }

    function tokens(value) {
        return normalize(value).match(/[\p{L}\p{N}_-]+/gu) || [];
    }

    function tokenizeGherkinText(value) {
        const source = String(value || '');
        const result = [];
        const pattern = /(^[ \t]*)(Given|When|Then|And|But|If|Допустим|Пусть|К тому же|Также|Дано|Когда|Тогда|Если|И|Но)(?=[ \t]|$)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|<[^>\r\n]+>|%\d+(?:[ \t]+[^\s"'|<>]+)?|\|/gimu;
        let cursor = 0;
        const append = (kind, text) => {
            if (!text) {
                return;
            }
            const previous = result[result.length - 1];
            if (previous?.kind === kind) {
                previous.text += text;
            } else {
                result.push({ kind, text });
            }
        };
        for (const match of source.matchAll(pattern)) {
            append('plain', source.slice(cursor, match.index));
            if (match[2]) {
                append('plain', match[1]);
                append('keyword', match[2]);
            } else if (match[0] === '|') {
                append('table', match[0]);
            } else if (match[0].startsWith('"') || match[0].startsWith("'")) {
                append('string', match[0]);
            } else {
                append('parameter', match[0]);
            }
            cursor = (match.index || 0) + match[0].length;
        }
        append('plain', source.slice(cursor));
        return result;
    }

    function preserveScrollPosition(element, action) {
        const scrollTop = element.scrollTop;
        const scrollLeft = element.scrollLeft;
        try {
            return action();
        } finally {
            element.scrollTop = scrollTop;
            element.scrollLeft = scrollLeft;
        }
    }

    function prepareItems(items) {
        return (items || []).map(item => {
            if (item && item.__stepLibraryPrepared === true) {
                return item;
            }
            const normalizedDisplayText = normalize(item.displayText);
            return {
                ...item,
                __stepLibraryPrepared: true,
                __normalizedDisplayText: normalizedDisplayText,
                __displayTokens: tokens(normalizedDisplayText),
                __normalizedTemplateText: normalize(item.template || item.displayText),
                __normalizedSearchText: normalize(item.searchText)
            };
        });
    }

    function compareText(left, right) {
        return left < right ? -1 : left > right ? 1 : 0;
    }

    function hasTokenPrefix(displayTokens, queryTokens) {
        let displayIndex = 0;
        for (const queryToken of queryTokens) {
            while (
                displayIndex < displayTokens.length
                && !displayTokens[displayIndex].startsWith(queryToken)
            ) {
                displayIndex += 1;
            }
            if (displayIndex >= displayTokens.length) {
                return false;
            }
            displayIndex += 1;
        }
        return queryTokens.length > 0;
    }

    function matchRank(item, normalizedQuery, queryTokens) {
        if (!normalizedQuery) {
            return 0;
        }
        const display = item.__normalizedDisplayText || normalize(item.displayText);
        if (display === normalizedQuery) {
            return 0;
        }
        if (display.startsWith(normalizedQuery)) {
            return 1;
        }
        if (hasTokenPrefix(item.__displayTokens || tokens(display), queryTokens)) {
            return 2;
        }
        const template = item.__normalizedTemplateText
            || normalize(item.template || item.displayText);
        if (display.includes(normalizedQuery) || template.includes(normalizedQuery)) {
            return 3;
        }
        if ((item.__normalizedSearchText || normalize(item.searchText)).includes(normalizedQuery)) {
            return 4;
        }
        return null;
    }

    function isCategoryAncestor(selectedPath, itemPath) {
        if (!selectedPath || selectedPath.length === 0) {
            return true;
        }
        if (!Array.isArray(itemPath) || selectedPath.length > itemPath.length) {
            return false;
        }
        return selectedPath.every((segment, index) => segment === itemPath[index]);
    }

    function isVisibleInLanguage(item, language) {
        return language === undefined
            || language === 'both'
            || item.sourceGroup !== 'builtIn'
            || item.language === language;
    }

    function searchItems(items, query, options) {
        const resolvedOptions = options || {};
        const normalizedQuery = normalize(query);
        const queryTokens = tokens(normalizedQuery);
        const ranked = [];
        for (const item of items || []) {
            if (
                resolvedOptions.sourceGroup
                && item.sourceGroup !== resolvedOptions.sourceGroup
            ) {
                continue;
            }
            if (!isCategoryAncestor(resolvedOptions.categoryPath, item.categoryPath)) {
                continue;
            }
            if (
                resolvedOptions.uncategorized === true
                && Array.isArray(item.categoryPath)
                && item.categoryPath.length > 0
            ) {
                continue;
            }
            if (!isVisibleInLanguage(item, resolvedOptions.language)) {
                continue;
            }
            const rank = matchRank(item, normalizedQuery, queryTokens);
            if (rank === null) {
                continue;
            }
            ranked.push({
                item,
                rank,
                display: item.__normalizedDisplayText || normalize(item.displayText)
            });
        }
        ranked.sort((left, right) =>
            left.rank - right.rank
            || compareText(left.display, right.display)
            || compareText(String(left.item.id), String(right.item.id))
        );
        const offset = Math.max(0, Number.isFinite(resolvedOptions.offset)
            ? Math.floor(resolvedOptions.offset)
            : 0);
        const limit = Math.max(0, Number.isFinite(resolvedOptions.limit)
            ? Math.floor(resolvedOptions.limit)
            : DEFAULT_RESULT_LIMIT);
        return ranked.slice(offset, offset + limit).map(entry => entry.item);
    }

    function nodeId(sourceGroup, path) {
        return `${sourceGroup}::${path.map(encodeURIComponent).join('/')}`;
    }

    function uncategorizedNodeId(sourceGroup) {
        return `${sourceGroup}::${UNCATEGORIZED_SENTINEL}`;
    }

    function isUncategorizedNodeId(value) {
        return typeof value === 'string'
            && value.endsWith(`::${UNCATEGORIZED_SENTINEL}`);
    }

    function categoryNode(sourceGroup, label, path) {
        return {
            id: nodeId(sourceGroup, path),
            sourceGroup,
            label,
            path,
            count: 0,
            children: [],
            childByLabel: new Map()
        };
    }

    function serializableNode(node, uncategorizedId) {
        const children = [...node.children]
            .sort((left, right) => {
                if (left.id === uncategorizedId) {
                    return 1;
                }
                if (right.id === uncategorizedId) {
                    return -1;
                }
                return compareText(normalize(left.label), normalize(right.label));
            })
            .map(child => serializableNode(child, uncategorizedId));
        return {
            id: node.id,
            sourceGroup: node.sourceGroup,
            label: node.label,
            path: [...node.path],
            count: node.count,
            children
        };
    }

    function buildCategoryTree(items, labels) {
        const resolvedLabels = labels || {};
        const sourceLabels = {
            ...DEFAULT_SOURCE_LABELS,
            ...(resolvedLabels.sources || {})
        };
        const uncategorizedLabel = resolvedLabels.uncategorized || 'Uncategorized';
        const roots = new Map();
        for (const item of items || []) {
            const group = item.sourceGroup;
            let rootNode = roots.get(group);
            if (!rootNode) {
                rootNode = categoryNode(group, sourceLabels[group] || group, []);
                rootNode.id = group;
                roots.set(group, rootNode);
            }
            rootNode.count += 1;
            const path = Array.isArray(item.categoryPath) ? item.categoryPath : [];
            if (path.length === 0) {
                const uncategorizedId = uncategorizedNodeId(group);
                let uncategorized = rootNode.childByLabel.get(uncategorizedId);
                if (!uncategorized) {
                    uncategorized = categoryNode(group, uncategorizedLabel, []);
                    uncategorized.id = uncategorizedId;
                    rootNode.childByLabel.set(uncategorizedId, uncategorized);
                    rootNode.children.push(uncategorized);
                }
                uncategorized.count += 1;
                continue;
            }
            let parent = rootNode;
            const currentPath = [];
            for (const segment of path) {
                currentPath.push(segment);
                const key = nodeId(group, currentPath);
                let child = parent.childByLabel.get(key);
                if (!child) {
                    child = categoryNode(group, segment, [...currentPath]);
                    parent.childByLabel.set(key, child);
                    parent.children.push(child);
                }
                child.count += 1;
                parent = child;
            }
        }
        return SOURCE_ORDER
            .filter(group => roots.has(group))
            .map(group => serializableNode(
                roots.get(group),
                uncategorizedNodeId(group)
            ));
    }

    function reconcileCategorySelection(items, selection) {
        const requestedSource = selection?.sourceGroup;
        const sourceGroup = SOURCE_ORDER.includes(requestedSource)
            && (items || []).some(item => item.sourceGroup === requestedSource)
            ? requestedSource
            : null;
        if (!sourceGroup) {
            return { sourceGroup: null, categoryPath: [], uncategorized: false };
        }

        const sourceItems = (items || []).filter(item => item.sourceGroup === sourceGroup);
        if (selection?.uncategorized === true) {
            const hasUncategorized = sourceItems.some(item =>
                !Array.isArray(item.categoryPath) || item.categoryPath.length === 0
            );
            if (hasUncategorized) {
                return { sourceGroup, categoryPath: [], uncategorized: true };
            }
        }

        const categoryPath = Array.isArray(selection?.categoryPath)
            ? [...selection.categoryPath]
            : [];
        while (categoryPath.length > 0) {
            const survives = sourceItems.some(item =>
                isCategoryAncestor(categoryPath, item.categoryPath)
            );
            if (survives) {
                break;
            }
            categoryPath.pop();
        }
        return { sourceGroup, categoryPath, uncategorized: false };
    }

    function canInsertItem(item, insertionTargetAvailable) {
        return Boolean(item && item.insertable !== false && insertionTargetAvailable);
    }

    return Object.freeze({
        searchItems,
        prepareItems,
        buildCategoryTree,
        reconcileCategorySelection,
        canInsertItem,
        isUncategorizedNodeId,
        tokenizeGherkinText,
        preserveScrollPosition
    });
}));
