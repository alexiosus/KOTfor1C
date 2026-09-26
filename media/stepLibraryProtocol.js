(function attachStepLibraryProtocol(root, factory) {
    'use strict';
    const protocol = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = protocol;
    }
    root.StepLibraryProtocol = protocol;
}(typeof globalThis === 'object' ? globalThis : this, function createStepLibraryProtocol() {
    'use strict';

    const SOURCE_ORDER = ['builtIn', 'user', 'export', 'nested'];
    const DEFAULT_SOURCE_LABELS = Object.freeze({
        builtIn: 'Vanessa',
        user: 'User steps',
        export: 'Export scenarios',
        nested: 'Nested scenarios'
    });
    const DEFAULT_RESULT_LIMIT = 100;

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
        const display = normalize(item.displayText);
        if (display === normalizedQuery) {
            return 0;
        }
        if (display.startsWith(normalizedQuery)) {
            return 1;
        }
        if (hasTokenPrefix(tokens(display), queryTokens)) {
            return 2;
        }
        const template = normalize(item.template || item.displayText);
        if (display.includes(normalizedQuery) || template.includes(normalizedQuery)) {
            return 3;
        }
        if (normalize(item.searchText).includes(normalizedQuery)) {
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
                display: normalize(item.displayText)
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
                const uncategorizedId = `${group}::uncategorized`;
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
                `${group}::uncategorized`
            ));
    }

    return Object.freeze({
        searchItems,
        buildCategoryTree
    });
}));
