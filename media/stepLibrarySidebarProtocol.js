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
        const byKey = new Map();
        if (Array.isArray(source.relationships)) {
            for (const candidate of source.relationships) {
                if (!candidate || typeof candidate !== 'object' || typeof candidate.scenarioKey !== 'string') {
                    continue;
                }
                const scenarioKey = candidate.scenarioKey.trim();
                if (!scenarioKey) {
                    continue;
                }
                const current = byKey.get(scenarioKey) || { scenarioKey };
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
                byKey.set(scenarioKey, current);
            }
        }
        const relationships = Object.freeze([...byKey.values()]
            .sort((left, right) => left.scenarioKey.localeCompare(right.scenarioKey))
            .map(entry => Object.freeze(entry)));
        return Object.freeze({
            enabled: source.enabled !== false,
            currentScenarioKeys: uniqueStrings(source.currentScenarioKeys),
            relationships,
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
        if (!scenarioKey) {
            return noDecoration();
        }
        const relationshipState = asState(state).relationshipState;
        if (relationshipState.currentScenarioKeys.includes(scenarioKey)) {
            return Object.freeze({
                state: 'current',
                icon: 'eye',
                classNames: Object.freeze(['is-current']),
                direct: true,
                accessibleLabel: label('current', 'Currently open scenario')
            });
        }
        if (!relationshipState.enabled) {
            return noDecoration();
        }
        const relationship = relationshipState.relationships.find(entry => entry.scenarioKey === scenarioKey);
        if (relationship) {
            const incoming = relationship.incomingDistance;
            const outgoing = relationship.outgoingDistance;
            const useIncoming = incoming !== undefined;
            const distance = useIncoming ? incoming : outgoing;
            const direct = distance === 1;
            const stateName = useIncoming ? 'incoming' : 'outgoing';
            const icon = useIncoming ? 'arrow-right-to-line' : 'arrow-right-from-line';
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
                icon,
                classNames: Object.freeze(classNames),
                direct,
                accessibleLabel
            });
        }
        if (relationshipState.affectedMainScenarioKeys.includes(scenarioKey)) {
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

    return Object.freeze({
        createState,
        toggleExpanded,
        selectNode,
        moveSelection,
        withRelationshipState,
        relationshipDecorationForNode,
        parseRelationshipState
    });
}));
