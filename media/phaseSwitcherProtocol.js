(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.PhaseSwitcherProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    const parsedRelationshipStateMarker = Symbol('parsedRelationshipState');
    const currentKeySetKey = Symbol('currentKeySet');
    const relationshipByKeyKey = Symbol('relationshipByKey');
    const affectedMainKeySetKey = Symbol('affectedMainKeySet');

    function normalizedUniqueStrings(value) {
        if (!Array.isArray(value)) {
            return [];
        }
        const result = [];
        const seen = new Set();
        value.forEach(item => {
            const normalized = typeof item === 'string' ? item.trim() : '';
            if (!normalized || seen.has(normalized)) {
                return;
            }
            seen.add(normalized);
            result.push(normalized);
        });
        return result;
    }

    function normalizedDistance(value) {
        return Number.isInteger(value) && value > 0 ? value : undefined;
    }

    function parseRelationshipState(value) {
        if (value?.[parsedRelationshipStateMarker] === true) {
            return value;
        }

        const source = value && typeof value === 'object' ? value : {};
        const relationshipsByKey = new Map();
        const relationshipOrder = [];
        if (Array.isArray(source.relationships)) {
            source.relationships.forEach(rawEntry => {
                const scenarioKey = typeof rawEntry?.scenarioKey === 'string'
                    ? rawEntry.scenarioKey.trim()
                    : '';
                if (!scenarioKey) {
                    return;
                }
                if (!relationshipsByKey.has(scenarioKey)) {
                    relationshipsByKey.set(scenarioKey, { scenarioKey });
                    relationshipOrder.push(scenarioKey);
                }
                const entry = relationshipsByKey.get(scenarioKey);
                const incomingDistance = normalizedDistance(rawEntry.incomingDistance);
                const outgoingDistance = normalizedDistance(rawEntry.outgoingDistance);
                if (
                    incomingDistance !== undefined
                    && (entry.incomingDistance === undefined || incomingDistance < entry.incomingDistance)
                ) {
                    entry.incomingDistance = incomingDistance;
                }
                if (
                    outgoingDistance !== undefined
                    && (entry.outgoingDistance === undefined || outgoingDistance < entry.outgoingDistance)
                ) {
                    entry.outgoingDistance = outgoingDistance;
                }
            });
        }
        const relationships = relationshipOrder
            .map(scenarioKey => relationshipsByKey.get(scenarioKey))
            .filter(entry => entry.incomingDistance !== undefined || entry.outgoingDistance !== undefined)
            .map(entry => Object.freeze(entry));
        const currentScenarioKeys = normalizedUniqueStrings(source.currentScenarioKeys);
        const affectedMainScenarioKeys = normalizedUniqueStrings(source.affectedMainScenarioKeys);
        const affectedPhaseNames = normalizedUniqueStrings(source.affectedPhaseNames);
        const currentLabel = typeof source.currentLabel === 'string' && source.currentLabel.trim()
            ? source.currentLabel.trim()
            : null;
        const parsed = {
            enabled: source.enabled !== false,
            currentScenarioKeys: Object.freeze(currentScenarioKeys),
            relationships: Object.freeze(relationships),
            affectedMainScenarioKeys: Object.freeze(affectedMainScenarioKeys),
            affectedPhaseNames: Object.freeze(affectedPhaseNames),
            currentLabel
        };
        Object.defineProperties(parsed, {
            [parsedRelationshipStateMarker]: { value: true },
            [currentKeySetKey]: { value: new Set(currentScenarioKeys) },
            [relationshipByKeyKey]: {
                value: new Map(relationships.map(entry => [entry.scenarioKey, entry]))
            },
            [affectedMainKeySetKey]: { value: new Set(affectedMainScenarioKeys) }
        });
        return Object.freeze(parsed);
    }

    function emptyScenarioDecoration() {
        return Object.freeze({
            state: 'none',
            icon: null,
            direct: false,
            accessibleLabel: ''
        });
    }

    function relationshipDirectionLabel(direction, distance) {
        if (direction === 'incoming') {
            return distance === 1
                ? 'Calls the open scenario directly'
                : `Calls the open scenario through ${distance} scenarios`;
        }
        return distance === 1
            ? 'Called by the open scenario directly'
            : `Called by the open scenario through ${distance} scenarios`;
    }

    function relationshipDecorationForScenario(scenarioKey, state) {
        const key = typeof scenarioKey === 'string' ? scenarioKey.trim() : '';
        if (!key) {
            return emptyScenarioDecoration();
        }
        const parsed = parseRelationshipState(state);
        if (parsed[currentKeySetKey].has(key)) {
            return Object.freeze({
                state: 'current',
                icon: 'eye',
                direct: true,
                accessibleLabel: 'Currently open scenario'
            });
        }
        if (!parsed.enabled) {
            return emptyScenarioDecoration();
        }

        const relationship = parsed[relationshipByKeyKey].get(key);
        if (relationship) {
            const incomingDistance = relationship.incomingDistance;
            const outgoingDistance = relationship.outgoingDistance;
            const accessibleParts = [];
            if (incomingDistance !== undefined) {
                accessibleParts.push(relationshipDirectionLabel('incoming', incomingDistance));
            }
            if (outgoingDistance !== undefined) {
                accessibleParts.push(relationshipDirectionLabel('outgoing', outgoingDistance));
            }
            if (incomingDistance !== undefined) {
                return Object.freeze({
                    state: 'incoming',
                    icon: 'arrow-right-to-line',
                    direct: incomingDistance === 1,
                    accessibleLabel: accessibleParts.join('; ')
                });
            }
            return Object.freeze({
                state: 'outgoing',
                icon: 'arrow-right-from-line',
                direct: outgoingDistance === 1,
                accessibleLabel: accessibleParts.join('; ')
            });
        }
        if (parsed[affectedMainKeySetKey].has(key)) {
            return Object.freeze({
                state: 'related',
                icon: null,
                direct: false,
                accessibleLabel: 'Related main scenario'
            });
        }
        return emptyScenarioDecoration();
    }

    function aggregatePhaseRelationship(scenarioKeys, state) {
        const parsed = parseRelationshipState(state);
        if (!parsed.enabled) {
            return Object.freeze({
                state: 'none',
                icon: null,
                count: 0,
                direct: false,
                accessibleLabel: ''
            });
        }
        const decorations = normalizedUniqueStrings(scenarioKeys)
            .map(key => relationshipDecorationForScenario(key, parsed))
            .filter(decoration => decoration.state !== 'none');
        if (decorations.length === 0) {
            return Object.freeze({
                state: 'none',
                icon: null,
                count: 0,
                direct: false,
                accessibleLabel: ''
            });
        }
        const count = decorations.length;
        return Object.freeze({
            state: 'related',
            icon: 'git-branch',
            count,
            direct: decorations.every(decoration => decoration.direct),
            accessibleLabel: count === 1
                ? '1 related scenario in this phase'
                : `${count} related scenarios in this phase`
        });
    }

    function selectionAggregateForKeys(selectedKeys, visibleKeys) {
        const selected = new Set(normalizedUniqueStrings(selectedKeys));
        const visible = normalizedUniqueStrings(visibleKeys);
        if (visible.length === 0) {
            return 'unchecked';
        }
        const selectedCount = visible.filter(key => selected.has(key)).length;
        if (selectedCount === 0) {
            return 'unchecked';
        }
        return selectedCount === visible.length ? 'checked' : 'indeterminate';
    }

    function nextVisibleSelection(currentKeys, visibleKeys, mode) {
        const current = normalizedUniqueStrings(currentKeys);
        const visible = normalizedUniqueStrings(visibleKeys);
        const visibleSet = new Set(visible);
        const currentSet = new Set(current);
        let shouldSelect;
        if (mode === 'select') {
            shouldSelect = true;
        } else if (mode === 'clear') {
            shouldSelect = false;
        } else if (mode === 'toggle') {
            shouldSelect = !visible.every(key => currentSet.has(key));
        } else {
            throw new Error(`Unsupported visible-selection mode: ${String(mode)}`);
        }

        const next = current.filter(key => !visibleSet.has(key));
        if (shouldSelect) {
            visible.forEach(key => next.push(key));
        }
        return Object.freeze(next);
    }

    function getScenarioKey(testInfo) {
        return typeof testInfo?.scenarioKey === 'string'
            ? testInfo.scenarioKey.trim()
            : '';
    }

    function createScenarioCommand(command, testInfo, extra = {}) {
        const key = getScenarioKey(testInfo);
        if (!key) {
            throw new Error('Scenario runtime key is required');
        }

        return {
            command,
            key,
            name: typeof testInfo?.name === 'string' ? testInfo.name : '',
            uri: typeof testInfo?.yamlFileUriString === 'string'
                ? testInfo.yamlFileUriString
                : key,
            ...extra
        };
    }

    return {
        getScenarioKey,
        createScenarioCommand,
        parseRelationshipState,
        relationshipDecorationForScenario,
        aggregatePhaseRelationship,
        selectionAggregateForKeys,
        nextVisibleSelection
    };
});
