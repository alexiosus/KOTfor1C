export interface AgentUiCommand { command: string; editor?: boolean; mutates?: boolean; execution?: boolean; argument?: 'uri' | 'path' }

/** Explicit native entry points; never accept an arbitrary VS Code command or argument list. */
export const agentUiCommands: readonly AgentUiCommand[] = [
    ...['openSubscenario', 'openNestedScenarioFromFeature', 'openProjectDefinition', 'findCurrentFileReferences',
        'openCurrentScenarioFilesFolder', 'openProcessTestSettingsFromEditor', 'openProjectMetadata', 'openScenarioEditor',
        'showFavoriteScenarios', 'revealFileInExplorer', 'revealFileInOS'].map(command => ({ command, editor: true })),
    ...['setScenarioCategory', 'insertNestedScenarioRef', 'insertScenarioParam', 'insertUid', 'replaceTabsWithSpacesYaml',
        'addCompilerYamlBlock', 'changeNestedScenarioName', 'addActiveScenarioToFavorites', 'removeActiveScenarioFromFavorites',
        'toggleActiveScenarioFavorite', 'changeScenarioSystemFunctionFromEditor', 'changeTestSettingsEtalonBaseFromEditor',
        'changeTestSettingsScenarioFromEditor', 'changeTestSettingsUserProfileFromEditor', 'syncTestSettingsFromScenario'].map(command => ({ command, editor: true, mutates: true })),
    { command: 'openMainScenarioTestSettingsFromEditor', editor: true },
    ...['phaseSwitcherView', 'infobaseSidebarView', 'stepLibrarySidebarView', 'scenarioProperties', 'vanessaVariables'].flatMap(view =>
        ['open', 'focus', 'resetViewLocation', 'toggleVisibility', 'removeView'].map(operation => ({ command: view + '.' + operation }))),
    ...['refreshGherkinSteps', 'enableDemoMode', 'setDemoStateForScenario', 'openYamlParametersManager',
        'openFormExplorer', 'openStepLibrary', 'openInfobaseManager', 'toggleTestManagerRelationshipHighlight', 'toggleTestManagerRelationshipFilter',
        'setTestManagerStatusFilterAll', 'setTestManagerStatusFilterBuilt', 'setTestManagerStatusFilterRunning',
        'toggleStepLibraryRelationshipHighlight', 'toggleStepLibraryRelationshipFilter', 'refreshStepLibrarySidebar', 'refreshInfobaseSidebar',
        'refreshPhaseSwitcher', 'toggleTestManagerGroups', 'toggleStepLibraryGroups', 'openConfigurationDiffReport', 'openTestReviewReport', 'openYamlParametersFromSettings',
        'openSettings', 'toggleEditorActionButtons', 'vanessaControl.diagnostics', 'vanessaControl.variables', 'vanessaControl.variables.refresh'].map(command => ({ command })),
    ...['showCreateScenarioMenu', 'vanessaControl.connectionSettings'].map(command => ({ command, mutates: true })),
    ...['openVanessa', 'startFormExplorerBridge', 'configureVanessaDebugClients', 'vanessaControl', 'vanessaControl.start',
        'vanessaControl.attach', 'vanessaControl.connect', 'vanessaControl.clients', 'vanessaControl.legacyClients', 'vanessaControl.settings', 'vanessaControl.formTools',
        'generateFormExplorerExtension', 'buildFormExplorerExtensionCfe', 'installFormExplorerExtension', 'startFormExplorerInfobase'].map(command => ({ command, mutates: true, execution: true })),
    { command: 'refreshCombinedRunJsonArtifacts', mutates: true },
    ...['openScenarioInVanessaManual', 'vanessaControl.oneStep', 'vanessaControl.runFromLine'].map(command => ({ command, editor: true, mutates: true, execution: true })),
    { command: 'vanessaControl.variables.set', mutates: true, execution: true },
    { command: 'vanessaControl.recording.copy' },
    { command: 'openFile', editor: true, execution: true },
    { command: 'openMxlFile', editor: true, execution: true },
    { command: 'openMxlFileFromExplorer', editor: true, execution: true, argument: 'uri' },
    { command: 'openBuildFolder', editor: true, argument: 'path' }
];

export const canonicalAgentCommand = (command: string): string => command.replace(/^kotTestToolkit\.editorMenu\./u, 'kotTestToolkit.').replace(/Checked$/u, '');

/** Bootstrap, shutdown and trust decisions stay in the user's native UI. */
export const agentUserCommands: Readonly<Record<string, string>> = {
    startSetup: 'Initial project setup is completed by the user in the native KOT wizard.',
    'agent.setup': 'Client connection and agent permissions require native user decisions.',
    'agent.start': 'Starting the MCP server bootstraps access; run this from the native UI.',
    'agent.stop': 'Stopping this MCP server must not await its own active action.',
    'agent.approveRepair': 'Only the user can approve a repair; the agent cannot approve its own changes.'
};

export const agentInternalCommands: Readonly<Record<string, string>> = {
    _addScenarioFavoriteByUri: 'Internal link callback; use scenario.favorite with a current itemId.',
    _processSourceFilesChanged: 'Internal file watcher notification; public refresh and repair operations are available.',
    'completion.advanceFormExplorerArgument': 'Internal completion cursor callback; select source/line/character in an editor action.'
};
