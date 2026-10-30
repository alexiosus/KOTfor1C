(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.StepLibrarySidebarProtocol = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function uniqueStrings(value) {
        if (!Array.isArray(value)) {
            return Object.freeze([]);
        }
        const result = [];
        const seen = new Set();
        for (const candidate of value) {
            if (typeof candidate !== 'string') {
                continue;
            }
            const normalized = candidate.trim();
            if (!normalized || seen.has(normalized)) {
                continue;
            }
            seen.add(normalized);
            result.push(normalized);
        }
        return Object.freeze(result);
    }

    function positiveDistance(value) {
        return Number.isInteger(value) && value > 0 ? value : undefined;
    }

    function parseRelationshipState(value) {
        const source = value && typeof value === 'object' ? value : {};
        const normalizeRelationships = (values, keyName) => {
            const byKey = new Map();
            if (!Array.isArray(values)) {
                return Object.freeze([]);
            }
            for (const candidate of values) {
                if (!candidate || typeof candidate !== 'object' || typeof candidate[keyName] !== 'string') {
                    continue;
                }
                const key = candidate[keyName].trim();
                if (!key) {
                    continue;
                }
                const current = byKey.get(key) || { [keyName]: key };
                const incomingDistance = positiveDistance(candidate.incomingDistance);
                const outgoingDistance = positiveDistance(candidate.outgoingDistance);
                if (incomingDistance !== undefined) {
                    current.incomingDistance = current.incomingDistance === undefined
                        ? incomingDistance
                        : Math.min(current.incomingDistance, incomingDistance);
                }
                if (outgoingDistance !== undefined) {
                    current.outgoingDistance = current.outgoingDistance === undefined
                        ? outgoingDistance
                        : Math.min(current.outgoingDistance, outgoingDistance);
                }
                byKey.set(key, current);
            }
            return Object.freeze([...byKey.values()]
            .sort((left, right) => left[keyName].localeCompare(right[keyName]))
            .map(entry => Object.freeze(entry)));
        };
        const relationships = normalizeRelationships(source.relationships, 'scenarioKey');
        const definitionRelationships = normalizeRelationships(
            source.definitionRelationships,
            'definitionId'
        );
        return Object.freeze({
            enabled: source.enabled !== false,
            currentScenarioKeys: uniqueStrings(source.currentScenarioKeys),
            relationships,
            currentDefinitionIds: uniqueStrings(source.currentDefinitionIds),
            definitionRelationships,
            affectedMainScenarioKeys: uniqueStrings(source.affectedMainScenarioKeys),
            affectedPhaseNames: uniqueStrings(source.affectedPhaseNames),
            currentLabel: typeof source.currentLabel === 'string' && source.currentLabel.trim()
                ? source.currentLabel.trim()
                : null
        });
    }

    function createState(value) {
        const source = value && typeof value === 'object' ? value : {};
        return Object.freeze({
            expandedIds: uniqueStrings(source.expandedIds),
            selectedId: typeof source.selectedId === 'string' && source.selectedId.trim()
                ? source.selectedId.trim()
                : null,
            relationshipState: parseRelationshipState(source.relationshipState)
        });
    }

    function asState(value) {
        if (value
            && typeof value === 'object'
            && Object.isFrozen(value)
            && Array.isArray(value.expandedIds)
            && Object.prototype.hasOwnProperty.call(value, 'relationshipState')) {
            return value;
        }
        return createState(value);
    }

    function toggleExpanded(state, nodeId) {
        const current = asState(state);
        if (typeof nodeId !== 'string' || !nodeId.trim()) {
            return current;
        }
        const id = nodeId.trim();
        const expanded = new Set(current.expandedIds);
        if (expanded.has(id)) {
            expanded.delete(id);
        } else {
            expanded.add(id);
        }
        return Object.freeze({
            expandedIds: Object.freeze([...expanded]),
            selectedId: current.selectedId,
            relationshipState: current.relationshipState
        });
    }

    function selectNode(state, nodeId) {
        const current = asState(state);
        const selectedId = typeof nodeId === 'string' && nodeId.trim() ? nodeId.trim() : null;
        if (selectedId === current.selectedId) {
            return current;
        }
        return Object.freeze({
            expandedIds: current.expandedIds,
            selectedId,
            relationshipState: current.relationshipState
        });
    }

    function moveSelection(state, visibleIds, delta) {
        const current = asState(state);
        const visible = uniqueStrings(visibleIds);
        if (visible.length === 0) {
            return current;
        }
        const currentIndex = visible.indexOf(current.selectedId);
        const start = currentIndex >= 0 ? currentIndex : (delta < 0 ? visible.length : -1);
        const amount = Number.isFinite(delta) ? Math.trunc(delta) : 0;
        const nextIndex = Math.max(0, Math.min(visible.length - 1, start + amount));
        return selectNode(current, visible[nextIndex]);
    }

    function withRelationshipState(state, relationshipState) {
        const current = asState(state);
        return Object.freeze({
            expandedIds: current.expandedIds,
            selectedId: current.selectedId,
            relationshipState: parseRelationshipState(relationshipState)
        });
    }

    function noDecoration() {
        return Object.freeze({
            state: 'none',
            icon: null,
            classNames: Object.freeze([]),
            direct: false,
            accessibleLabel: ''
        });
    }

    function relationshipDecorationForNode(node, state, labels) {
        const localized = labels && typeof labels === 'object' ? labels : {};
        const label = (key, fallback) => typeof localized[key] === 'string' && localized[key]
            ? localized[key]
            : fallback;
        const distanceLabel = (key, fallback, distance) => label(key, fallback)
            .replace('{0}', String(distance));
        const scenarioKey = node && typeof node === 'object' && typeof node.scenarioKey === 'string'
            ? node.scenarioKey.trim()
            : '';
        const definitionId = node && typeof node === 'object' && typeof node.definitionId === 'string'
            ? node.definitionId.trim()
            : '';
        if (!scenarioKey && !definitionId) {
            return noDecoration();
        }
        const relationshipState = asState(state).relationshipState;
        if (!relationshipState.enabled) {
            return noDecoration();
        }
        if ((scenarioKey && relationshipState.currentScenarioKeys.includes(scenarioKey))
            || (definitionId && relationshipState.currentDefinitionIds.includes(definitionId))) {
            return Object.freeze({
                state: 'current',
                icon: null,
                classNames: Object.freeze(['is-related']),
                direct: true,
                accessibleLabel: label('current', 'Currently open scenario')
            });
        }
        const relationship = (
            scenarioKey
                ? relationshipState.relationships.find(entry => entry.scenarioKey === scenarioKey)
                : undefined
        ) ?? (
            definitionId
                ? relationshipState.definitionRelationships.find(entry => entry.definitionId === definitionId)
                : undefined
        );
        if (relationship) {
            const incoming = relationship.incomingDistance;
            const outgoing = relationship.outgoingDistance;
            const useIncoming = incoming !== undefined;
            const distance = useIncoming ? incoming : outgoing;
            const direct = distance === 1;
            const stateName = useIncoming ? 'incoming' : 'outgoing';
            const classNames = ['is-related', `is-${stateName}`];
            if (!direct) {
                classNames.push('is-transitive');
            }
            const accessibleLabel = useIncoming
                ? (direct
                    ? label('incomingDirect', 'Calls the open scenario directly')
                    : distanceLabel('incomingTransitive', 'Calls the open scenario through {0} scenarios', distance))
                : (direct
                    ? label('outgoingDirect', 'Called by the open scenario directly')
                    : distanceLabel('outgoingTransitive', 'Called by the open scenario through {0} scenarios', distance));
            return Object.freeze({
                state: stateName,
                icon: null,
                classNames: Object.freeze(classNames),
                direct,
                accessibleLabel
            });
        }
        if (scenarioKey && relationshipState.affectedMainScenarioKeys.includes(scenarioKey)) {
            return Object.freeze({
                state: 'related',
                icon: null,
                classNames: Object.freeze(['is-related', 'is-transitive']),
                direct: false,
                accessibleLabel: label('containsRelated', 'Contains a scenario related to the open scenario')
            });
        }
        return noDecoration();
    }

    function isNodeRelationshipMatch(node, state) {
        const relationshipState = asState(state).relationshipState;
        const scenarioKey = typeof node?.scenarioKey === 'string' ? node.scenarioKey.trim() : '';
        const definitionId = typeof node?.definitionId === 'string' ? node.definitionId.trim() : '';
        return (scenarioKey !== '' && (
            relationshipState.currentScenarioKeys.includes(scenarioKey)
            || relationshipState.relationships.some(entry => entry.scenarioKey === scenarioKey)
            || relationshipState.affectedMainScenarioKeys.includes(scenarioKey)
        )) || (definitionId !== '' && (
            relationshipState.currentDefinitionIds.includes(definitionId)
            || relationshipState.definitionRelationships.some(entry => entry.definitionId === definitionId)
        ));
    }

    function shouldHighlightRelationshipAncestor(nodeId, relatedAncestorIds, state) {
        return asState(state).relationshipState.enabled
            && relatedAncestorIds.has(nodeId);
    }

    function nodeTooltip(node) {
        if (!node || typeof node !== 'object') {
            return '';
        }
        const description = typeof node.description === 'string' ? node.description.trim() : '';
        if (description) {
            return description;
        }
        return typeof node.label === 'string' ? node.label.trim() : '';
    }

    function resetRelationshipPagingOnFilterChange(
        previousEnabled,
        nextEnabled,
        pageCache,
        requestCache
    ) {
        if ((previousEnabled === true) === (nextEnabled === true)) {
            return false;
        }
        pageCache.clear();
        requestCache.clear();
        return true;
    }

    function displayedNodeCount(node, relationshipFilterEnabled, visibleCounts) {
        if (!node || typeof node.count !== 'number') {
            return undefined;
        }
        if (!relationshipFilterEnabled || !visibleCounts || typeof visibleCounts !== 'object') {
            return node.count;
        }
        const visibleCount = visibleCounts[node.id];
        return typeof visibleCount === 'number' ? visibleCount : node.count;
    }

    function bulkExpansionTransition(previousExpandedIds, nextExpandedIds) {
        const previous = new Set(uniqueStrings(previousExpandedIds));
        const next = new Set(uniqueStrings(nextExpandedIds));
        return Object.freeze({
            expandingIds: Object.freeze([...next].filter(id => !previous.has(id))),
            collapsingIds: Object.freeze([...previous].filter(id => !next.has(id)))
        });
    }

    function createBulkExpansionController(options) {
        let active = false;
        let expandedIds = new Set();
        const pendingIds = new Set();
        const requestedIds = new Set();

        const advance = () => {
            if (!active) {
                return;
            }
            for (const node of options.getExpandableNodes()) {
                expandedIds.add(node.id);
                if (options.hasChildren(node.id) || requestedIds.has(node.id)) {
                    continue;
                }
                requestedIds.add(node.id);
                if (options.requestChildren(node)) {
                    pendingIds.add(node.id);
                }
            }
            if (pendingIds.size > 0) {
                return;
            }
            active = false;
            options.onComplete(Object.freeze([...expandedIds]));
        };

        return Object.freeze({
            get active() {
                return active;
            },
            start(initialExpandedIds) {
                active = true;
                expandedIds = new Set(uniqueStrings(initialExpandedIds));
                pendingIds.clear();
                requestedIds.clear();
                advance();
            },
            childrenLoaded(parentId) {
                if (!active || !pendingIds.delete(parentId)) {
                    return false;
                }
                advance();
                return true;
            },
            cancel() {
                active = false;
                expandedIds.clear();
                pendingIds.clear();
                requestedIds.clear();
            }
        });
    }

    return Object.freeze({
        createState,
        toggleExpanded,
        selectNode,
        moveSelection,
        withRelationshipState,
        relationshipDecorationForNode,
        isNodeRelationshipMatch,
        shouldHighlightRelationshipAncestor,
        resetRelationshipPagingOnFilterChange,
        displayedNodeCount,
        bulkExpansionTransition,
        parseRelationshipState,
        nodeTooltip,
        createBulkExpansionController
    });
}));
