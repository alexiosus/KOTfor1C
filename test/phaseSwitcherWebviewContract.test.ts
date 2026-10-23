import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const phaseSwitcherWebviewSource = require('node:fs').readFileSync(
    path.join(process.cwd(), 'media', 'phaseSwitcher.js'),
    'utf8'
);

test('Connect Vanessa becomes Control Vanessa for an active session and hides the adjacent settings gear', () => {
    assert.doesNotMatch(phaseSwitcherHtmlSource, /id="vanessaConnectionSettingsBtn"/u);
    const start = phaseSwitcherWebviewSource.indexOf('    function updateTopRunButtonState()');
    const end = phaseSwitcherWebviewSource.indexOf('\n    function ', start + 1);
    class Button { disabled = false; title = ''; label = { textContent: '' }; querySelector() { return this.label; } }
    const button = new Button(); const state = { connected: false, busy: false };
    const sandbox = { HTMLButtonElement: Button, openVanessaBtn: button, settings: { switcherEnabled: true },
        isBuildInProgress: false, vanessaControlState: state, window: { __loc: {} } };
    vm.runInNewContext(`${phaseSwitcherWebviewSource.slice(start, end)}\nupdateTopRunButtonState();`, sandbox);
    assert.equal(button.label.textContent, 'Connect Vanessa');
    state.connected = true;
    vm.runInNewContext('updateTopRunButtonState();', sandbox); assert.equal(button.label.textContent, 'Control Vanessa');
    state.busy = true;
    vm.runInNewContext('updateTopRunButtonState();', sandbox); assert.equal(button.disabled, true);
    assert.match(phaseSwitcherWebviewSource, /command: vanessaControlState\.connected \? 'vanessaControl' : 'openVanessa'/u);
    assert.match(phaseSwitcherProviderSource, /public updateVanessaControlState\(/u);
});
const phaseSwitcherHtmlSource = require('node:fs').readFileSync(
    path.join(process.cwd(), 'media', 'phaseSwitcher.html'),
    'utf8'
);
const phaseSwitcherCssSource = require('node:fs').readFileSync(
    path.join(process.cwd(), 'media', 'phaseSwitcher.css'),
    'utf8'
);
const phaseSwitcherProviderSource = require('node:fs').readFileSync(
    path.join(process.cwd(), 'src', 'phaseSwitcher.ts'),
    'utf8'
);
const phaseSwitcherProtocolSource = require('node:fs').readFileSync(
    path.join(process.cwd(), 'media', 'phaseSwitcherProtocol.js'),
    'utf8'
);
const scenarioFilesProtocolSource = require('node:fs').readFileSync(
    path.join(process.cwd(), 'media', 'scenarioFilesProtocol.js'),
    'utf8'
);
const extensionSource = require('node:fs').readFileSync(
    path.join(process.cwd(), 'src', 'extension.ts'),
    'utf8'
);
const packageManifest = JSON.parse(require('node:fs').readFileSync(
    path.join(process.cwd(), 'package.json'),
    'utf8'
));

const protocol = require(path.join(process.cwd(), 'media', 'phaseSwitcherProtocol.js')) as {
    getScenarioKey(testInfo: unknown): string;
    createScenarioCommand(
        command: string,
        testInfo: unknown,
        extra?: Record<string, unknown>
    ): Record<string, unknown>;
    createGroupScenarioCommand(command: string, groupName: unknown): Record<string, unknown>;
};

test('scenario protocol creates exact URI-backed command payloads', () => {
    const testInfo = {
        scenarioKey: 'file:///a/scen.yaml',
        name: 'Duplicate',
        yamlFileUriString: 'file:///a/scen.yaml'
    };

    assert.equal(protocol.getScenarioKey(testInfo), 'file:///a/scen.yaml');
    assert.deepEqual(protocol.createScenarioCommand('runScenarioInVanessa', testInfo), {
        command: 'runScenarioInVanessa',
        key: 'file:///a/scen.yaml',
        name: 'Duplicate',
        uri: 'file:///a/scen.yaml'
    });
    assert.deepEqual(protocol.createScenarioCommand('openScenarioJsonArtifactInEditor', testInfo, {
        variant: 'combined'
    }), {
        command: 'openScenarioJsonArtifactInEditor',
        key: 'file:///a/scen.yaml',
        name: 'Duplicate',
        uri: 'file:///a/scen.yaml',
        variant: 'combined'
    });
});

test('scenario protocol rejects incomplete runtime identities', () => {
    assert.throws(
        () => protocol.createScenarioCommand('openScenario', {
            name: 'Missing key',
            yamlFileUriString: 'file:///a/scen.yaml'
        }),
        /runtime key/i
    );
});

test('group creation protocol sends the exact trimmed Test Manager group', () => {
    assert.deepEqual(protocol.createGroupScenarioCommand('createMainScenario', '  Production 2  '), {
        command: 'createMainScenario',
        groupName: 'Production 2'
    });
    assert.throws(
        () => protocol.createGroupScenarioCommand('createMainScenario', undefined),
        /group name/i
    );
    for (const command of ['createMainScenario', 'createProcess']) {
        assert.deepEqual(protocol.createGroupScenarioCommand(command, ''), { command, groupName: '' });
    }
    assert.throws(() => protocol.createGroupScenarioCommand('renameGroup', ''), /group name/i);
});

test('group context menu posts the protocol actions for the selected group', () => {
    const handlerStart = phaseSwitcherWebviewSource.indexOf('    function handlePhaseContextMenu(event)');
    const handlerEnd = phaseSwitcherWebviewSource.indexOf(
        '    function handleScenarioContextMenu(event)',
        handlerStart
    );
    const handlerSource = phaseSwitcherWebviewSource.slice(handlerStart, handlerEnd);

    assert.notEqual(handlerStart, -1);
    assert.notEqual(handlerEnd, -1);
    assert.match(handlerSource, /createPhaseContextMenuActions\(phaseName/u);
    assert.match(handlerSource, /vscode\.postMessage\(groupId && action\.message\.command === 'renameGroup'/u);
    assert.match(handlerSource, /\{ \.\.\.action\.message, groupId \} : action\.message/u);
});

test('Accounting mode uses the same native dropdown control as profiles', () => {
    assert.match(phaseSwitcherHtmlSource, /<select id="recordGLSelect"[^>]*class="[^"]*surface-select[^"]*assemble-profile-select/u);
    assert.match(phaseSwitcherHtmlSource, /<option value="0">GL-<\/option>/u);
    assert.match(phaseSwitcherHtmlSource, /<option value="1">GL\+<\/option>/u);
    assert.match(phaseSwitcherHtmlSource, /<option value="2" selected>Templates<\/option>/u);
    assert.doesNotMatch(phaseSwitcherHtmlSource, /recordGLModeList|record-gl-option-btn/u);
});

test('run-state refresh preserves URI-backed checkbox identity', () => {
    const syncFunctionStart = phaseSwitcherWebviewSource.indexOf('    function syncScenarioLeadingControl(');
    const nextFunctionStart = phaseSwitcherWebviewSource.indexOf(
        '    function syncScenarioProgress(',
        syncFunctionStart
    );
    assert.notEqual(syncFunctionStart, -1);
    assert.notEqual(nextFunctionStart, -1);

    const syncFunctionSource = phaseSwitcherWebviewSource.slice(syncFunctionStart, nextFunctionStart);
    assert.match(syncFunctionSource, /existingCheckbox\.name = viewState\.scenarioKey;/);
    assert.doesNotMatch(syncFunctionSource, /existingCheckbox\.name = viewState\.name;/);
});

test('demo run state is overlaid by exact scenario URI key', () => {
    assert.match(
        phaseSwitcherWebviewSource,
        /const scenarioKey = scenarioProtocol\.getScenarioKey\(info\)/
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /demoOverlay\[scenarioKey\] = buildDemoRunArtifact\(name, stateKey\)/
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /const scenarioKey = message\.key;[\s\S]*?\{ \[scenarioKey\]: artifact \}/
    );
});

test('Test Manager creation actions use the native view title menu', () => {
    assert.doesNotMatch(phaseSwitcherHtmlSource, /createExportScenarioFromDropdownBtn|createUserStepFromDropdownBtn/u);
    const actions = packageManifest.contributes.menus['view/title'] as Array<{ command: string; when: string }>;
    const phaseCommands = actions
        .filter(action => action.when === 'view == kotTestToolkit.phaseSwitcherView')
        .map(action => action.command);
    assert.ok(phaseCommands.includes('kotTestToolkit.showCreateScenarioMenu'));
    const commandContributions = packageManifest.contributes.commands as Array<{
        command: string;
        category?: string;
    }>;
    for (const command of phaseCommands) {
        assert.equal(
            commandContributions.find(candidate => candidate.command === command)?.category,
            undefined,
            `${command} must not be prefixed with the extension category in the Test Manager menu`
        );
    }
});

test('Test Manager script only binds top-level controls present in its HTML template', () => {
    const templateIds = new Set(
        Array.from(phaseSwitcherHtmlSource.matchAll(/\bid="([^"]+)"/gu), match => match[1])
    );
    const missingIds = Array.from(
        phaseSwitcherWebviewSource.matchAll(/document\.getElementById\('([^']+)'\)/gu),
        match => match[1]
    )
        .filter(id => !templateIds.has(id))
        .sort();

    assert.deepEqual(missingIds, []);
});

test('Test Manager CSS only targets top-level ids present in its HTML template', () => {
    const templateIds = new Set(
        Array.from(phaseSwitcherHtmlSource.matchAll(/\bid="([^"]+)"/gu), match => match[1])
    );
    const missingIds = Array.from(
        phaseSwitcherCssSource.matchAll(/^\s*#([A-Za-z_][A-Za-z0-9_-]*)(?=[\s.:>,+~{])/gmu),
        match => match[1]
    )
        .filter(id => !templateIds.has(id))
        .sort();

    assert.deepEqual(missingIds, []);
});

test('Test Manager CSS has no selectors for removed webview classes', () => {
    const webviewSources = [
        phaseSwitcherHtmlSource,
        phaseSwitcherWebviewSource,
        phaseSwitcherProtocolSource,
        scenarioFilesProtocolSource
    ].join('\n');
    const unreferencedClasses = Array.from(
        new Set(
            Array.from(
                phaseSwitcherCssSource.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/gu),
                match => match[1]
            )
        )
    )
        .filter(className => className !== 'css' && !webviewSources.includes(className))
        .sort();

    assert.deepEqual(unreferencedClasses, []);
});

test('Test Manager provider does not publish state for removed webview menus', () => {
    const initialStateStart = phaseSwitcherProviderSource.indexOf(
        '    private async _sendInitialState(webview: vscode.Webview)'
    );
    const nextMethodStart = phaseSwitcherProviderSource.indexOf(
        '    private async ensureSharedStartupInfobaseReady(',
        initialStateStart
    );

    assert.notEqual(initialStateStart, -1);
    assert.notEqual(nextMethodStart, -1);

    const initialStateSource = phaseSwitcherProviderSource.slice(initialStateStart, nextMethodStart);
    assert.doesNotMatch(
        initialStateSource,
        /favorites:|favoriteSortMode|configurationDiffReport|testReviewReport/u
    );
    assert.doesNotMatch(
        phaseSwitcherProviderSource,
        /command: 'update(?:Favorites|ConfigurationDiffReport|TestReviewReport)State'/u
    );
});

test('Test Manager webview has no unreferenced named functions', () => {
    const unreferenced = Array.from(
        phaseSwitcherWebviewSource.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/gu),
        match => match[1]
    )
        .filter(name => {
            const references = phaseSwitcherWebviewSource.match(
                new RegExp(`\\b${name}\\b`, 'gu')
            );
            return (references?.length ?? 0) === 1;
        })
        .sort();

    assert.deepEqual(unreferenced, []);
});

test('Test Manager provider has no unreferenced private methods', () => {
    const unreferenced = Array.from(
        phaseSwitcherProviderSource.matchAll(
            /\bprivate\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gu
        ),
        match => match[1]
    )
        .filter(name => {
            const references = phaseSwitcherProviderSource.match(
                new RegExp(`\\b${name}\\b`, 'gu')
            );
            return (references?.length ?? 0) === 1;
        })
        .sort();

    assert.deepEqual(unreferenced, []);
});

test('phase aggregate checkbox is synchronized after the header controls are attached', () => {
    const headerStart = phaseSwitcherWebviewSource.indexOf(
        "            const phaseHeaderDiv = document.createElement('div');"
    );
    const listStart = phaseSwitcherWebviewSource.indexOf(
        "            const testsListDiv = document.createElement('div');",
        headerStart
    );
    assert.notEqual(headerStart, -1);
    assert.notEqual(listStart, -1);

    const headerSource = phaseSwitcherWebviewSource.slice(headerStart, listStart);
    const attachCheckbox = headerSource.indexOf('phaseHeaderDiv.appendChild(phaseCheckbox);');
    const synchronizeAggregate = headerSource.indexOf(
        'updatePhaseCountButton(countElement, phaseName, enabledCount, totalInPhase);'
    );
    assert.ok(attachCheckbox >= 0);
    assert.ok(synchronizeAggregate > attachCheckbox);
});

test('Step Library full-page action is contributed to its native view title', () => {
    assert.doesNotMatch(phaseSwitcherHtmlSource, /id="openStepLibraryTopBtn"/u);
    assert.match(extensionSource, /registerCommand\(\s*'kotTestToolkit\.openStepLibrary'/u);
    const actions = packageManifest.contributes.menus['view/title'] as Array<{ command: string; when: string }>;
    assert.ok(actions.some(action =>
        action.command === 'kotTestToolkit.openStepLibrary'
        && action.when === 'view == kotTestToolkit.stepLibrarySidebarView'
    ));
});

test('Compile and Vanessa share the bottom row until their labels require wrapping', () => {
    const css = require('node:fs').readFileSync(
        path.join(process.cwd(), 'media', 'phaseSwitcher.css'),
        'utf8'
    );
    const bottomActionsCss = css.slice(css.lastIndexOf('/* Bottom primary actions'));

    assert.match(phaseSwitcherHtmlSource, /id="assembleSplitContainer"/u);
    assert.match(phaseSwitcherHtmlSource, /id="openVanessaBtn"/u);
    assert.match(phaseSwitcherHtmlSource, /src="\$\{vanessaLogoUri\}"/u);
    assert.match(
        bottomActionsCss,
        /\.controls-row\.controls-row-primary\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/isu
    );
    assert.match(
        bottomActionsCss,
        /\.controls-row\.controls-row-primary\s*>\s*\.split-button,[^{]*#openVanessaBtn\s*\{[^}]*flex:\s*1\s+1\s+calc\(50%\s*-\s*2px\)[^}]*min-width:\s*max-content[^}]*box-sizing:\s*border-box/isu
    );
    assert.match(
        bottomActionsCss,
        /#assembleTestsBtn,[^{]*#openVanessaBtn\s*\{[^}]*box-sizing:\s*border-box/isu
    );
    assert.doesNotMatch(bottomActionsCss, /grid-template-columns/iu);
    assert.match(
        css,
        /#assembleTestsBtn,\s*#assembleMenuBtn,\s*#openVanessaBtn\s*\{/isu
    );
    assert.doesNotMatch(phaseSwitcherHtmlSource, /createFirstLaunchBtn/u);
    assert.doesNotMatch(phaseSwitcherWebviewSource, /createFirstLaunchBtn|driveActionsRow/u);
    assert.doesNotMatch(css, /createFirstLaunchBtn|driveActionsRow/u);
    assert.match(css, /#openVanessaBtn\s*\{[^}]*justify-content:\s*center/isu);
    assert.match(phaseSwitcherWebviewSource, /openVanessaBtn\.addEventListener\('click'/u);
    assert.match(phaseSwitcherWebviewSource, /vscode\.postMessage\(\{ command: vanessaControlState\.connected \? 'vanessaControl' : 'openVanessa' \}\)/u);
    assert.match(phaseSwitcherProviderSource, /case 'openVanessa':[\s\S]*?executeCommand\('kotTestToolkit\.vanessaControl\.connect'\)/u);
    assert.match(phaseSwitcherProviderSource, /replace\('\$\{vanessaLogoUri\}', vanessaLogoUri\.toString\(\)\)/u);
});

test('compiled scenario resources reuse the shared tree row, disclosure, and open-file affordances', () => {
    assert.match(
        phaseSwitcherWebviewSource,
        /class="scenario-resource-row[^"`]*kot-tree-row/u
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /class="scenario-resource-disclosure kot-tree-disclosure codicon codicon-chevron-/u
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /class="scenario-resource-label kot-tree-label"/u
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /class="scenario-resource-file-icon scenario-file-icon"/u
    );
    assert.match(phaseSwitcherWebviewSource, /open-scenario-icon-idle/u);
    assert.match(phaseSwitcherWebviewSource, /open-scenario-icon-action/u);
    assert.doesNotMatch(phaseSwitcherWebviewSource, /scenario-resource-open-btn/u);
});

test('compiled scenario root expansion uses the existing Test Manager group animation helper', () => {
    assert.match(
        phaseSwitcherWebviewSource,
        /setPhaseListExpandedState\(resourceTree, true, true\)/u
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /setPhaseListExpandedState\(resourceTree, false, true, \(\) =>/u
    );
});

test('Files branches reuse the Library per-node request and animation model', () => {
    assert.match(
        phaseSwitcherWebviewSource,
        /requestId:\s*node\.id/u
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /function animateScenarioResourceExpansion\(expansionId\)[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?requestAnimationFrame\(\(\) => \{/u
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /function animateScenarioResourceExpansion[\s\S]*?window\.setTimeout\(finish, 260\)/u
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /renderPhaseTree[\s\S]*?\.is-entering\[data-resource-expansion-id\][\s\S]*?animateScenarioResourceExpansion/u
    );
});

test('explicit Test Manager refresh rescans compiled artifacts before publishing the refreshed tree', () => {
    const refreshStart = phaseSwitcherProviderSource.indexOf(
        '    public async refreshFromExternalStateChange('
    );
    const refreshEnd = phaseSwitcherProviderSource.indexOf(
        '    private getScanDirAbsolutePath()',
        refreshStart
    );
    const refreshSource = phaseSwitcherProviderSource.slice(refreshStart, refreshEnd);

    assert.notEqual(refreshStart, -1);
    assert.notEqual(refreshEnd, -1);
    assert.match(refreshSource, /await this\.refreshScenarioBuildArtifactsFromDisk\(workspaceRootUri\)/u);
    assert.ok(
        refreshSource.indexOf('refreshScenarioBuildArtifactsFromDisk')
            < refreshSource.indexOf('this._sendInitialState'),
        'compiled artifacts must be refreshed before the webview receives its initial state'
    );
});

test('artifact change publication includes hash freshness state', () => {
    assert.match(
        phaseSwitcherProviderSource,
        /this\._staleBuiltScenarioNames\.has\(scenarioKey\) \? 'stale' : 'current'/u
    );
});

test('Test Manager can recover a compiled Files request from a stale in-memory artifact map', () => {
    assert.match(
        phaseSwitcherProviderSource,
        /private async resolveCompiledScenarioFileItem[\s\S]*?refreshScenarioBuildArtifactsFromDisk[\s\S]*?compiledScenarioFileItem/u
    );
    assert.match(
        phaseSwitcherProviderSource,
        /const item = await this\.resolveCompiledScenarioFileItem\(message\.itemId\)/u
    );
});

test('phase headers expose a passive compiled-tests indicator next to their count', () => {
    assert.match(phaseSwitcherWebviewSource, /className = 'phase-compiled-indicator'/u);
    assert.match(phaseSwitcherWebviewSource, /function countCompiledTestsInPhase\(/u);
    assert.match(
        phaseSwitcherWebviewSource,
        /compiledIndicator\.hidden = compiledCount === 0/u
    );
    assert.match(
        phaseSwitcherCssSource,
        /\.phase-compiled-indicator\s*\{[^}]*border-radius:\s*50%[^}]*pointer-events:\s*none/isu
    );
    assert.match(phaseSwitcherWebviewSource, /className = 'phase-count-cluster'/u);
    assert.match(
        phaseSwitcherWebviewSource,
        /phaseCountCluster\.append\(compiledIndicator, countElement\)/u
    );
    assert.match(
        phaseSwitcherCssSource,
        /\.phase-count-cluster\s*\{[^}]*display:\s*inline-flex[^}]*white-space:\s*nowrap/isu
    );
});

test('Test Manager recomputes fade distances when the panel is resized', () => {
    assert.match(
        phaseSwitcherWebviewSource,
        /new ResizeObserver\(\(\) => updateScenarioLabelOverflow\(\)\)/u
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /scenarioLabelResizeObserver\.observe\(phaseTreeContainer\)/u
    );
});

test('Test Manager search uses the shared search field and concise placeholder', () => {
    assert.match(phaseSwitcherProviderSource, /scenarioSearchPlaceholder:\s*this\.t\('Search main scenario'\)/u);
    assert.match(phaseSwitcherHtmlSource, /class="scenario-search-input-wrap search-frame kot-search-frame"/u);
    assert.match(phaseSwitcherHtmlSource, /id="scenarioSearchClearBtn"[\s\S]*?kot-search-clear/u);
});

test('compiled feature rows use the scenario-files route and the provider opens the compiled URI', () => {
    assert.match(
        phaseSwitcherWebviewSource,
        /node\.dataset\.kind === 'feature'[\s\S]*?command: 'openCompiledScenarioFeature',[\s\S]*?itemId/u
    );
    assert.match(
        phaseSwitcherProviderSource,
        /case 'openCompiledScenarioFeature':[\s\S]*?service\.openCompiledFeature\(item\)[\s\S]*?action: 'openFeature'/u
    );
});

test('rerendered expanded scenario resources keep their natural height', () => {
    assert.match(
        phaseSwitcherCssSource,
        /\.scenario-resource-tree\.expanded,\s*\.scenario-resource-children\.expanded\s*\{[^}]*max-height:\s*none/isu
    );
});

test('PhaseSwitcher consumes shared relationship state without mutating build selection', () => {
    assert.match(
        phaseSwitcherProviderSource,
        /public attachRelationshipService\(service: ScenarioRelationshipService\)/u
    );

    const messageStart = phaseSwitcherProviderSource.indexOf(
        '    private sendRelationshipStateToWebview('
    );
    const activeEditorStart = phaseSwitcherProviderSource.indexOf(
        '    public handleActiveEditorChanged(',
        messageStart
    );
    assert.notEqual(messageStart, -1);
    assert.notEqual(activeEditorStart, -1);

    const relationshipMessageSource = phaseSwitcherProviderSource.slice(messageStart, activeEditorStart);
    assert.match(relationshipMessageSource, /this\._relationshipService\?\.getState\(\)/u);
    assert.doesNotMatch(relationshipMessageSource, /buildCallersByCalleeFromCache/u);
    assert.match(relationshipMessageSource, /command: 'updateRelationshipState'/u);
    for (const property of [
        'currentScenarioKeys',
        'relationships',
        'currentDefinitionIds',
        'definitionRelationships',
        'affectedMainScenarioKeys',
        'affectedPhaseNames',
        'currentLabel',
        'enabled'
    ]) {
        assert.match(relationshipMessageSource, new RegExp(`\\b${property}\\b`, 'u'));
    }
    assert.doesNotMatch(
        relationshipMessageSource,
        /_mainScenarioSelectionStates|updateScenarioSelection|checkbox|buildScenario/u
    );
    assert.doesNotMatch(phaseSwitcherProviderSource, /case 'setRelationshipHighlightEnabled':/u);
    assert.match(
        phaseSwitcherWebviewSource,
        /relationshipState = scenarioProtocol\.parseRelationshipState\(message\.relationshipState\)/u
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /case 'updateRelationshipState':[\s\S]*?scenarioProtocol\.parseRelationshipState\(message\)/u
    );
});

test('PhaseSwitcher receives the persisted status filter and patches it incrementally', () => {
    assert.match(
        phaseSwitcherProviderSource,
        /public attachStatusFilterService\(service: Pick<[\s\S]*?TestManagerStatusFilterService,[\s\S]*?'getMode'\s*\|\s*'onDidChangeMode'[\s\S]*?>\)/u
    );
    assert.match(extensionSource, /phaseSwitcherProvider\.attachStatusFilterService\(testManagerStatusFilter\)/u);
    assert.match(
        phaseSwitcherProviderSource,
        /settings:\s*\{[\s\S]*?statusFilter:\s*this\._statusFilterService\?\.getMode\(\)\s*\?\?\s*'all'/u
    );
    assert.match(
        phaseSwitcherProviderSource,
        /command:\s*'updateStatusFilter',[\s\S]*?statusFilter:\s*event\.mode/u
    );
});

test('Test Manager centralizes search, relationship, and status visibility without rerendering for status changes', () => {
    assert.match(phaseSwitcherWebviewSource, /function applyScenarioVisibility\(/u);
    assert.match(
        phaseSwitcherWebviewSource,
        /scenarioProtocol\.visibleScenarioAggregate\([\s\S]*?relationshipPredicate[\s\S]*?searchPredicate/u
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /classList\.toggle\('status-hidden',\s*!statusMatch\)/u
    );
    assert.match(
        phaseSwitcherWebviewSource,
        /group\.classList\.toggle\('filter-hidden',\s*!hasVisibleScenario\)/u
    );

    for (const caseName of [
        'updateRunArtifactsState',
        'updateRelationshipState',
        'updateStatusFilter'
    ]) {
        const start = phaseSwitcherWebviewSource.indexOf(`case '${caseName}':`);
        const end = phaseSwitcherWebviewSource.indexOf('\n            case ', start + 1);
        assert.notEqual(start, -1, `${caseName} handler is present`);
        const block = phaseSwitcherWebviewSource.slice(start, end === -1 ? undefined : end);
        assert.match(block, /applyScenarioVisibility\(\)/u, `${caseName} reapplies visibility`);
        if (caseName === 'updateStatusFilter') {
            assert.doesNotMatch(block, /renderPhaseTree\(/u, 'status-only changes preserve the rendered tree');
        }
    }

    assert.match(
        phaseSwitcherWebviewSource,
        /function syncScenarioSearchHighlightState\([\s\S]*?applyScenarioVisibility\(\)/u
    );
});
