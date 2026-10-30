(function attachStepLibraryProtocol(root, factory) {
    'use strict';
    const protocol = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = protocol;
    }
    root.StepLibraryProtocol = protocol;
}(typeof globalThis === 'object' ? globalThis : this, function createStepLibraryProtocol() {
    'use strict';

    const SOURCE_ORDER = ['builtIn', 'user', 'export', 'nested', 'main', 'process', 'standalone'];
    const DEFAULT_SOURCE_LABELS = Object.freeze({
        builtIn: 'Vanessa',
        user: 'User steps',
        export: 'Exported scenarios',
        nested: 'Nested scenarios',
        main: 'Main scenarios',
        process: 'Processes',
        standalone: 'Standalone features'
    });
    const DEFAULT_RESULT_LIMIT = 100;
    const UNCATEGORIZED_SENTINEL = '#uncategorized';
    const PANE_RESIZER_TOTAL = 8;
    const MIN_CATEGORY_WIDTH = 180;
    const MIN_DEFINITION_WIDTH = 300;
    const MIN_DETAILS_WIDTH = 260;

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

    function createResultPager(items, batchSize, initialVisibleCount) {
        const values = Array.isArray(items) ? items : [];
        const size = Math.max(1, Number.isFinite(batchSize) ? Math.floor(batchSize) : DEFAULT_RESULT_LIMIT);
        const firstSize = Math.max(
            size,
            Number.isFinite(initialVisibleCount) ? Math.floor(initialVisibleCount) : 0
        );
        let offset = 0;
        return {
            get hasMore() {
                return offset < values.length;
            },
            next() {
                if (offset >= values.length) {
                    return [];
                }
                const pageSize = offset === 0 ? firstSize : size;
                const batch = values.slice(offset, offset + pageSize);
                offset += batch.length;
                return batch;
            }
        };
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

    function preferredLocalizedItems(items, language, preferredLanguage) {
        if (language !== 'both') {
            return items || [];
        }
        const preferred = preferredLanguage === 'ru' ? 'ru' : 'en';
        const result = [];
        const familyIndexes = new Map();
        for (const item of items || []) {
            if (item.sourceGroup !== 'builtIn' || !item.familyId) {
                result.push(item);
                continue;
            }
            const previousIndex = familyIndexes.get(item.familyId);
            if (previousIndex === undefined) {
                familyIndexes.set(item.familyId, result.length);
                result.push(item);
                continue;
            }
            const previous = result[previousIndex];
            if (previous.language !== preferred && item.language === preferred) {
                result[previousIndex] = item;
            }
        }
        return result;
    }

    function searchItems(items, query, options) {
        const resolvedOptions = options || {};
        const normalizedQuery = normalize(query);
        const queryTokens = tokens(normalizedQuery);
        const ranked = [];
        const localizedItems = preferredLocalizedItems(
            items,
            resolvedOptions.language,
            resolvedOptions.preferredLanguage
        );
        for (const item of localizedItems) {
            if (
                resolvedOptions.sourceGroup
                && item.sourceGroup !== resolvedOptions.sourceGroup
            ) {
                continue;
            }
            if (!isCategoryAncestor(resolvedOptions.categoryPath, item.categoryPath)) {
                continue;
            }
            if (resolvedOptions.groupId !== undefined && item.groupId !== resolvedOptions.groupId) {
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
            || (!normalizedQuery && left.item.sourceGroup === 'standalone' && right.item.sourceGroup === 'standalone'
                ? (left.item.groupOrder || 0) - (right.item.groupOrder || 0) || (left.item.order || 0) - (right.item.order || 0) : 0)
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

    function clamp(value, minimum, maximum) {
        return Math.min(Math.max(value, minimum), maximum);
    }

    function resizePaneLayout(layout, divider, deltaPixels, containerWidth) {
        const available = Math.max(
            MIN_CATEGORY_WIDTH + MIN_DEFINITION_WIDTH + MIN_DETAILS_WIDTH,
            Math.floor(containerWidth) - PANE_RESIZER_TOTAL
        );
        const rawCategory = Number.isFinite(layout?.categoryWidth)
            ? Math.round(layout.categoryWidth)
            : 270;
        const rawDetails = Number.isFinite(layout?.detailsWidth)
            ? Math.round(layout.detailsWidth)
            : 380;
        let detailsWidth = clamp(
            rawDetails,
            MIN_DETAILS_WIDTH,
            available - MIN_CATEGORY_WIDTH - MIN_DEFINITION_WIDTH
        );
        let categoryWidth = clamp(
            rawCategory,
            MIN_CATEGORY_WIDTH,
            available - detailsWidth - MIN_DEFINITION_WIDTH
        );
        detailsWidth = clamp(
            detailsWidth,
            MIN_DETAILS_WIDTH,
            available - categoryWidth - MIN_DEFINITION_WIDTH
        );
        const delta = Number.isFinite(deltaPixels) ? Math.round(deltaPixels) : 0;
        if (divider === 'category') {
            categoryWidth = clamp(
                categoryWidth + delta,
                MIN_CATEGORY_WIDTH,
                available - detailsWidth - MIN_DEFINITION_WIDTH
            );
        } else if (divider === 'details') {
            detailsWidth = clamp(
                detailsWidth - delta,
                MIN_DETAILS_WIDTH,
                available - categoryWidth - MIN_DEFINITION_WIDTH
            );
        }
        return { categoryWidth, detailsWidth };
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
                if (node.sourceGroup === 'standalone') {
                    return 0;
                }
                if (node.sourceGroup === 'main' || node.sourceGroup === 'process') {
                    const groupOrder = (left.groupOrder ?? Infinity) - (right.groupOrder ?? Infinity);
                    if (groupOrder) { return groupOrder; }
                }
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
            ...(node.groupId !== undefined ? { groupId: node.groupId } : {}),
            ...(node.scenarioGroupId !== undefined ? { scenarioGroupId: node.scenarioGroupId, groupOrder: node.groupOrder } : {}),
            ...(node.renameGroupItemId ? { renameGroupItemId: node.renameGroupItemId } : {}),
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
        for (const group of resolvedLabels.scenarioGroups || []) {
            for (const section of group.sections) {
                if (section !== 'main' && section !== 'process') { continue; }
                let root = roots.get(section);
                if (!root) {
                    root = categoryNode(section, sourceLabels[section], []);
                    root.id = section;
                    roots.set(section, root);
                }
                const node = categoryNode(section, group.name, [group.name]);
                node.scenarioGroupId = group.id;
                node.groupOrder = group.order;
                root.childByLabel.set(node.id, node);
                root.children.push(node);
            }
        }
        if (resolvedLabels.standaloneGroups !== undefined || (items || []).some(item => item.sourceGroup === 'standalone')) {
            const root = categoryNode('standalone', sourceLabels.standalone, []);
            root.id = 'standalone';
            for (const group of [{ id: '', name: resolvedLabels.ungrouped || 'Ungrouped' }, ...(resolvedLabels.standaloneGroups || [])]) {
                const node = categoryNode('standalone', group.name, group.id ? [group.name] : []);
                node.id = `standalone::group:${encodeURIComponent(group.id)}`;
                node.groupId = group.id;
                root.childByLabel.set(group.id, node);
                root.children.push(node);
            }
            roots.set('standalone', root);
        }
        for (const item of items || []) {
            const group = item.sourceGroup;
            let rootNode = roots.get(group);
            if (!rootNode) {
                rootNode = categoryNode(group, sourceLabels[group] || group, []);
                rootNode.id = group;
                roots.set(group, rootNode);
            }
            rootNode.count += 1;
            if (group === 'standalone') {
                const groupId = item.groupId || '';
                let child = rootNode.childByLabel.get(groupId);
                if (!child) {
                    child = categoryNode(group, item.categoryPath?.[0] || uncategorizedLabel, item.categoryPath || []);
                    child.id = `standalone::group:${encodeURIComponent(groupId)}`;
                    child.groupId = groupId;
                    rootNode.childByLabel.set(groupId, child);
                    rootNode.children.push(child);
                }
                child.count += 1;
                continue;
            }
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
            if ((group === 'main' || group === 'process') && path.length === 1 && (item.kind === 'mainScenario' || item.kind === 'process')) {
                parent.renameGroupItemId ||= item.id;
            }
        }
        return SOURCE_ORDER
            .filter(group => roots.has(group))
            .map(group => serializableNode(
                roots.get(group),
                uncategorizedNodeId(group)
            ));
    }

    function reconcileCategorySelection(items, selection, standaloneGroups, scenarioGroups) {
        if (selection?.sourceGroup === 'standalone' && standaloneGroups !== undefined) {
            const group = (standaloneGroups || []).find(value => value.id === selection.groupId);
            return {
                sourceGroup: 'standalone',
                categoryPath: group ? [group.name] : [],
                uncategorized: false,
                groupId: group ? group.id : selection.groupId === '' ? '' : undefined
            };
        }
        const requestedSource = selection?.sourceGroup;
        const declaredGroups = (scenarioGroups || []).filter(group => group.sections.includes(requestedSource));
        const sourceGroup = SOURCE_ORDER.includes(requestedSource)
            && ((items || []).some(item => item.sourceGroup === requestedSource) || declaredGroups.length > 0)
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
            ) || declaredGroups.some(group => isCategoryAncestor(categoryPath, [group.name]));
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

    function definitionPresentation(item, labels) {
        if (item.processUri) { return { icon: 'list-ordered', label: labels.processDefinition || 'Process' }; }
        return {
            builtIn: { icon: 'extensions', label: labels.builtInDefinition || 'Vanessa step' },
            user: { icon: 'symbol-method', label: labels.userDefinition || 'User step' },
            export: { icon: 'package', label: labels.exportDefinition || 'Export scenario' },
            nested: { icon: 'references', label: labels.nestedDefinition || 'Nested scenario' },
            main: { icon: 'file', label: labels.mainScenarioDefinition || 'Main scenario' },
            process: { icon: 'list-ordered', label: labels.processDefinition || 'Process' },
            standalone: { icon: 'file-code', label: labels.standaloneDefinition || 'Feature' }
        }[item.sourceGroup] || { icon: 'symbol-method', label: item.sourceLabel || '' };
    }

    function definitionRowActionOrder(item) {
        const actions = [];
        if (item?.insertable !== false) {
            actions.push('insert');
        }
        actions.push('copy');
        if (item?.navigable === true) {
            actions.push('openDefinition');
        }
        actions.push('favorite');
        return actions;
    }

    function overflowPresentation(scrollWidth, clientWidth) {
        const overflowWidth = Math.max(
            0,
            (Number.isFinite(scrollWidth) ? scrollWidth : 0)
                - (Number.isFinite(clientWidth) ? clientWidth : 0)
        );
        const overflowing = overflowWidth > 1;
        const distance = overflowing ? overflowWidth + 12 : 0;
        return {
            overflowing,
            distance,
            duration: Math.max(1.2, distance / 45)
        };
    }

    return Object.freeze({
        searchItems,
        prepareItems,
        buildCategoryTree,
        reconcileCategorySelection,
        canInsertItem,
        definitionPresentation,
        isUncategorizedNodeId,
        tokenizeGherkinText,
        preserveScrollPosition,
        createResultPager,
        resizePaneLayout,
        definitionRowActionOrder,
        overflowPresentation
    });
}));
