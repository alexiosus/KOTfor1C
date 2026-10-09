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
                icon: null,
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

    function isScenarioRelationshipHighlighted(scenarioKey, state) {
        const parsed = parseRelationshipState(state);
        return parsed.enabled
            && relationshipDecorationForScenario(scenarioKey, parsed).state !== 'none';
    }

    function isScenarioRelationshipMatch(scenarioKey, state) {
        const key = typeof scenarioKey === 'string' ? scenarioKey.trim() : '';
        if (!key) {
            return false;
        }
        const parsed = parseRelationshipState(state);
        return parsed[currentKeySetKey].has(key)
            || parsed[relationshipByKeyKey].has(key)
            || parsed[affectedMainKeySetKey].has(key);
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

    function matchesScenarioSearch(scenario, query) {
        const normalizedQuery = typeof query === 'string' ? query.trim().toLocaleLowerCase() : '';
        if (!normalizedQuery) {
            return true;
        }
        const name = typeof scenario?.name === 'string' ? scenario.name.toLocaleLowerCase() : '';
        const phaseName = typeof scenario?.phaseName === 'string' ? scenario.phaseName.toLocaleLowerCase() : '';
        return name.includes(normalizedQuery) || phaseName.includes(normalizedQuery);
    }

    function normalizeStatusFilter(value) {
        return value === 'built' || value === 'running' ? value : 'all';
    }

    function hasBuiltArtifact(runInfo) {
        if (!runInfo || typeof runInfo !== 'object') {
            return false;
        }
        return [
            runInfo.featurePath,
            runInfo.compiledFeatureUri,
            runInfo.jsonPath,
            runInfo.combinedJsonPath
        ].some(value => typeof value === 'string' && value.trim().length > 0);
    }

    function matchesStatusFilter(runInfo, mode) {
        const normalizedMode = normalizeStatusFilter(mode);
        if (normalizedMode === 'all') {
            return true;
        }
        if (normalizedMode === 'running') {
            return !!runInfo
                && typeof runInfo === 'object'
                && runInfo.runStatus === 'running';
        }
        return hasBuiltArtifact(runInfo);
    }

    function visibleScenarioAggregate(
        testInfos,
        states,
        runArtifacts,
        mode,
        relationshipPredicate = () => true,
        searchPredicate = () => true
    ) {
        const stateByKey = states && typeof states === 'object' ? states : {};
        const artifactsByKey = runArtifacts && typeof runArtifacts === 'object'
            ? runArtifacts
            : {};
        const visibleKeys = [];
        let selectedCount = 0;
        let totalCount = 0;
        for (const testInfo of Array.isArray(testInfos) ? testInfos : []) {
            const key = getScenarioKey(testInfo);
            if (!key
                || !matchesStatusFilter(artifactsByKey[key], mode)
                || !relationshipPredicate(testInfo, key)
                || !searchPredicate(testInfo, key)) {
                continue;
            }
            visibleKeys.push(key);
            const selectionState = stateByKey[key];
            if (selectionState === 'disabled') {
                continue;
            }
            totalCount += 1;
            if (selectionState === true || selectionState === 'checked') {
                selectedCount += 1;
            }
        }
        return Object.freeze({
            visibleKeys: Object.freeze(visibleKeys),
            selectedCount,
            totalCount
        });
    }

    function formatRunProgress(value) {
        const currentLineRaw = Number(value?.currentLine);
        const totalLinesRaw = Number(value?.totalLines);
        const percentRaw = Number(value?.percent);
        const iterationRaw = Number(value?.iteration);
        const currentLine = Number.isFinite(currentLineRaw) ? Math.max(0, Math.floor(currentLineRaw)) : 0;
        const totalLines = Number.isFinite(totalLinesRaw) ? Math.max(0, Math.floor(totalLinesRaw)) : 0;
        const hasLineProgress = value?.isRunning === true && currentLine > 0 && totalLines > 0;
        let percent = Number.isFinite(percentRaw) ? Math.max(0, Math.min(100, Math.floor(percentRaw))) : null;
        if (percent === null && hasLineProgress) {
            percent = Math.max(0, Math.min(100, Math.round((currentLine / totalLines) * 100)));
        }
        const iteration = Number.isFinite(iterationRaw) ? Math.max(1, Math.floor(iterationRaw)) : 1;
        const iterationSuffix = iteration > 1 ? ` · ×${iteration}` : '';
        return Object.freeze({
            hasLineProgress,
            percent,
            title: hasLineProgress
                ? `${currentLine}/${totalLines}${percent !== null ? ` (${percent}%)` : ''}${iterationSuffix}`
                : '',
            counterText: hasLineProgress ? `${currentLine}/${totalLines}${iterationSuffix}` : '',
            badgeText: hasLineProgress
                ? `${percent !== null ? `${percent}%` : `${currentLine}/${totalLines}`}${iterationSuffix}`
                : ''
        });
    }

    function compiledResourceSignature(runArtifacts) {
        if (!runArtifacts || typeof runArtifacts !== 'object') {
            return '';
        }
        return Object.keys(runArtifacts)
            .sort()
            .map(scenarioKey => {
                const value = runArtifacts[scenarioKey];
                if (!value || typeof value !== 'object') {
                    return '';
                }
                const featureUri = typeof value.compiledFeatureUri === 'string'
                    ? value.compiledFeatureUri.trim()
                    : '';
                const filesRootUri = typeof value.scenarioFilesRootUri === 'string'
                    ? value.scenarioFilesRootUri.trim()
                    : '';
                return featureUri || filesRootUri
                    ? `${scenarioKey}\u0000${featureUri}\u0000${filesRootUri}`
                    : '';
            })
            .filter(Boolean)
            .join('\u0001');
    }

    function compiledResourceLocation(value) {
        if (!value || typeof value !== 'object') {
            return '';
        }
        const featureUri = typeof value.compiledFeatureUri === 'string'
            ? value.compiledFeatureUri.trim()
            : '';
        const filesRootUri = typeof value.scenarioFilesRootUri === 'string'
            ? value.scenarioFilesRootUri.trim()
            : '';
        return featureUri || filesRootUri ? `${featureUri}\u0000${filesRootUri}` : '';
    }

    function changedCompiledResourceKeys(previousArtifacts, nextArtifacts) {
        const previous = previousArtifacts && typeof previousArtifacts === 'object'
            ? previousArtifacts
            : {};
        const next = nextArtifacts && typeof nextArtifacts === 'object'
            ? nextArtifacts
            : {};
        return Object.freeze([...new Set([...Object.keys(previous), ...Object.keys(next)])]
            .filter(key => compiledResourceLocation(previous[key]) !== compiledResourceLocation(next[key]))
            .sort());
    }

    function isCurrentScenarioFileResponse(expectedRequestId, responseRequestId) {
        return typeof expectedRequestId === 'string'
            && expectedRequestId.length > 0
            && expectedRequestId === responseRequestId;
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

    function createGroupScenarioCommand(command, groupName) {
        const normalizedGroupName = typeof groupName === 'string' ? groupName.trim() : '';
        if (!normalizedGroupName) {
            throw new Error('Scenario group name is required');
        }
        return { command, groupName: normalizedGroupName };
    }

    function createPhaseContextMenuActions(groupName, labels = {}) {
        return [
            {
                icon: 'codicon-add',
                label: labels.createMainScenario || 'Create main scenario',
                message: createGroupScenarioCommand('createMainScenario', groupName)
            },
            {
                icon: 'codicon-rename',
                label: labels.renameGroup || 'Rename group',
                message: createGroupScenarioCommand('renameGroup', groupName)
            }
        ];
    }

    return {
        getScenarioKey,
        createScenarioCommand,
        createGroupScenarioCommand,
        createPhaseContextMenuActions,
        parseRelationshipState,
        relationshipDecorationForScenario,
        isScenarioRelationshipHighlighted,
        isScenarioRelationshipMatch,
        aggregatePhaseRelationship,
        selectionAggregateForKeys,
        nextVisibleSelection,
        matchesScenarioSearch,
        normalizeStatusFilter,
        matchesStatusFilter,
        visibleScenarioAggregate,
        formatRunProgress,
        compiledResourceSignature,
        changedCompiledResourceKeys,
        isCurrentScenarioFileResponse
    };
});
