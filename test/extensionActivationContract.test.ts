import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
const completionProviderSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'completionProvider.ts'),
    'utf8'
);
const hoverProviderSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'hoverProvider.ts'),
    'utf8'
);
const formExplorerStepSuggestionsSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'formExplorerStepSuggestions.ts'),
    'utf8'
);
const phaseSwitcherSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'phaseSwitcher.ts'),
    'utf8'
);
const infobaseManagerPanelSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'infobaseManagerPanel.ts'),
    'utf8'
);
const phaseSwitcherConstructorSource = phaseSwitcherSource.slice(
    phaseSwitcherSource.indexOf('    constructor(extensionUri:'),
    phaseSwitcherSource.indexOf('    private async loadLocalizationBundleIfNeeded')
);
const phaseSwitcherResolveWebviewSource = phaseSwitcherSource.slice(
    phaseSwitcherSource.indexOf('    public async resolveWebviewView('),
    phaseSwitcherSource.indexOf('    private async _sendInitialState(')
);
const packageManifest = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'package.json'),
    'utf8'
)) as {
    contributes: {
        commands: Array<{ command: string; title: string; category: string }>;
        languages?: Array<{ id: string; aliases?: string[]; extensions?: string[]; configuration?: string }>;
        grammars?: Array<{ language: string; scopeName: string; path: string }>;
        menus: Record<string, Array<{ command: string; when?: string }>>;
        viewsContainers: {
            activitybar: Array<{ id: string; title: string; icon: string }>;
        };
        views: Record<string, Array<{
            id: string;
            name: string;
            type: string;
            contextualTitle?: string;
            icon?: string;
            visibility?: string;
            initialSize?: number;
        }>>;
    };
};

test('manifest provides a standalone Feature language and TextMate grammar', () => {
    const language = packageManifest.contributes.languages?.find(entry => entry.id === 'feature');
    assert.ok(language);
    assert.ok(language.extensions?.includes('.feature'));
    assert.equal(language.configuration, './syntaxes/feature-language-configuration.json');

    const grammar = packageManifest.contributes.grammars?.find(entry => entry.language === 'feature');
    assert.ok(grammar);
    assert.equal(grammar.scopeName, 'source.feature.kot');
    assert.equal(grammar.path, './syntaxes/feature.tmLanguage.json');
    assert.equal(fs.existsSync(path.join(process.cwd(), grammar.path)), true);
    assert.equal(fs.existsSync(path.join(process.cwd(), language.configuration)), true);
});

test('activation does not eagerly provision 1C helper infobases', () => {
    assert.doesNotMatch(source, /warmUpSharedStartupInfobase/);
    assert.doesNotMatch(source, /warmUpFormExplorerBuilder/);
    assert.doesNotMatch(source, /ensureOneCClientPathConfigured/);
});

test('activation defers optional panel modules until their commands are used', () => {
    assert.doesNotMatch(source, /import \{ FormExplorerPanel \} from '\.\/formExplorerPanel';/);
    assert.doesNotMatch(source, /import \{ InfobaseManagerPanel \} from '\.\/infobaseManagerPanel';/);
    assert.match(source, /import\('\.\/formExplorerPanel\.js'\)/);
    assert.match(source, /import\('\.\/infobaseManagerPanel\.js'\)/);
});

test('activation shares a lazy managed-infobase snapshot without eager 1C discovery', () => {
    assert.match(source, /new ManagedInfobaseService\(/u);
    assert.equal(source.match(/new ManagedInfobaseService\(/gu)?.length, 1);
    assert.match(source, /import\('\.\/infobaseManager\.js'\)/u);
    assert.match(source, /collectManagedInfobases\(context,\s*activeProfileInfobasePath\)/u);
    assert.match(source, /new InfobaseManagerPanel\(context,\s*managedInfobaseService,/u);
    assert.doesNotMatch(source, /from '\.\/infobaseManager';/u);
    assert.doesNotMatch(infobaseManagerPanelSource, /collectManagedInfobases/u);
    assert.match(infobaseManagerPanelSource, /managedInfobaseService\.(?:ensureReady|refresh)\(/u);
    const activationPrefix = source.slice(source.indexOf('export function activate('));
    assert.doesNotMatch(activationPrefix, /managedInfobaseService\.ensureReady\(/u);
    assert.doesNotMatch(activationPrefix, /collectManagedInfobases\(context\)(?!,)/u);
});

test('activation shares one scenario files service across both Library surfaces', () => {
    assert.equal(source.match(/new ScenarioFilesService\(/gu)?.length, 1);
    assert.match(source, /new StepLibrarySidebarProvider\(\{[\s\S]*?scenarioFilesService/u);
    assert.match(source, /new StepLibraryPanel\(\{[\s\S]*?scenarioFilesService/u);
    assert.match(source, /context\.subscriptions\.push\([\s\S]*?scenarioFilesService/u);
});

test('activation does not register artifact hash infrastructure', () => {
    assert.doesNotMatch(source, /ScenarioArtifactFreshnessService/u);
    assert.doesNotMatch(source, /ScenarioArtifactDependencyResolver/u);
    assert.doesNotMatch(source, /attachArtifactFreshnessService/u);
    assert.doesNotMatch(source, /scenarioArtifactReferenceService/u);
});

test('manifest contributes Library as an expanded dedicated Activity Bar view', () => {
    assert.deepEqual(
        packageManifest.contributes.views.kotTestToolkitContainer.map(view => ({
            id: view.id,
            type: view.type,
            initialSize: view.initialSize,
            visibility: view.visibility
        })),
        [
            {
                id: 'kotTestToolkit.phaseSwitcherView',
                type: 'webview',
                initialSize: 2,
                visibility: undefined
            },
            {
                id: 'kotTestToolkit.infobaseSidebarView',
                type: 'webview',
                initialSize: 1,
                visibility: undefined
            }
        ]
    );
    assert.deepEqual(
        packageManifest.contributes.views.kotTestToolkitLibraryContainer,
        [{
            id: 'kotTestToolkit.stepLibrarySidebarView',
            name: '%view.stepLibrary.name%',
            type: 'webview',
            contextualTitle: 'KOT for 1C',
            icon: 'res/icons/KOTLibrary.png'
        }]
    );
});

test('manifest assigns the supplied icon to the KOT container and each detachable view', () => {
    const container = packageManifest.contributes.viewsContainers.activitybar.find(entry =>
        entry.id === 'kotTestToolkitContainer'
    );
    assert.equal(container?.icon, 'res/icons/KOTCommon.png');
    const libraryContainer = packageManifest.contributes.viewsContainers.activitybar.find(entry =>
        entry.id === 'kotTestToolkitLibraryContainer'
    );
    assert.deepEqual(libraryContainer, {
        id: 'kotTestToolkitLibraryContainer',
        title: '%ext.displayName%',
        icon: 'res/icons/KOTLibrary.png'
    });

    const expectedViewIcons = new Map([
        ['kotTestToolkit.phaseSwitcherView', 'res/icons/KOTTestManager.png'],
        ['kotTestToolkit.stepLibrarySidebarView', 'res/icons/KOTLibrary.png'],
        ['kotTestToolkit.infobaseSidebarView', 'res/icons/KOTInfobases.png']
    ]);
    const views = Object.values(packageManifest.contributes.views).flat();
    for (const [viewId, iconPath] of expectedViewIcons) {
        assert.equal(views.find(view => view.id === viewId)?.icon, iconPath);
        assert.equal(fs.existsSync(path.join(process.cwd(), iconPath)), true, iconPath);
    }
});

test('step library is contributed to the palette and only YAML or feature editor titles', () => {
    const command = packageManifest.contributes.commands.find(entry =>
        entry.command === 'kotTestToolkit.openStepLibrary'
    );
    assert.deepEqual(command && {
        command: command.command,
        title: command.title,
        category: command.category
    }, {
        command: 'kotTestToolkit.openStepLibrary',
        title: '%cmd.openStepLibrary.title%',
        category: '%cmd.category%'
    });
    assert.ok(packageManifest.contributes.menus.commandPalette.some(entry =>
        entry.command === 'kotTestToolkit.openStepLibrary' && entry.when === 'true'
    ));
    const titleEntries = packageManifest.contributes.menus['editor/title'].filter(entry =>
        entry.command === 'kotTestToolkit.openStepLibrary'
    );
    assert.equal(titleEntries.length, 1);
    assert.match(titleEntries[0].when ?? '', /resourceExtname == \.yaml/u);
    assert.match(titleEntries[0].when ?? '', /resourceExtname == \.feature/u);
    assert.doesNotMatch(titleEntries[0].when ?? '', /\.json|\.txt/u);
});

test('activation shares step-library services between compact and full views', () => {
    assert.doesNotMatch(source, /from '\.\/stepLibraryPanel';/u);
    assert.match(source, /import\('\.\/stepLibraryPanel\.js'\)/u);
    assert.equal(source.match(/new StepLibraryPanel\(/gu)?.length, 1);
    assert.equal(source.match(/new StepLibrarySnapshotService\(/gu)?.length, 1);
    assert.equal(source.match(/new StepLibraryActionService\(/gu)?.length, 1);
    assert.equal(source.match(/new StepLibrarySidebarProvider\(/gu)?.length, 1);
    assert.match(source, /snapshotService,\s*actionService,/u);
    assert.match(source, /resolver:\s*projectDefinitionResolver/u);
    assert.match(source, /stepCatalogService\.refresh\(resource\)/u);
    assert.match(source, /projectDefinitionIndex\.reloadConfigurations\(\)/u);
    assert.match(source, /projectDefinitionIndex\.waitForIdle\(\)/u);
    assert.match(
        source,
        /phaseSwitcherProvider\.refreshFromExternalStateChange\(\{\s*refreshCache:\s*true\s*\}\)/u
    );
    assert.match(
        source,
        /registerCommand\(\s*'kotTestToolkit\.openStepLibrary'[\s\S]*?activeTextEditor\?\.document\.uri/u
    );
});

test('activation registers all workbench providers with retained hidden context', () => {
    for (const provider of [
        'PhaseSwitcherProvider',
        'StepLibrarySidebarProvider',
        'InfobaseSidebarProvider'
    ]) {
        assert.match(
            source,
            new RegExp(`registerWebviewViewProvider\\(\\s*${provider}\\.viewType,[\\s\\S]*?retainContextWhenHidden:\\s*true`, 'u')
        );
    }
    assert.doesNotMatch(source, /stepLibrarySnapshotService\.ensureReady\(/u);
});

test('active-editor changes reach the shared relationship service through Test Manager once', () => {
    assert.equal(source.match(/new ScenarioRelationshipService\(/gu)?.length, 1);
    assert.equal(source.match(/phaseSwitcherProvider\.attachRelationshipService\(/gu)?.length, 1);
    const listenerStart = source.indexOf('vscode.window.onDidChangeActiveTextEditor(editor => {');
    const listenerEnd = source.indexOf('\n        })', listenerStart);
    const listener = source.slice(listenerStart, listenerEnd);
    assert.equal(listener.match(/phaseSwitcherProvider\.handleActiveEditorChanged\(editor\)/gu)?.length, 1);
    assert.doesNotMatch(listener, /relationshipService\.handleActiveEditorChanged/u);
});

test('relationship title menus toggle persisted options without a Quick Pick confirmation step', () => {
    assert.doesNotMatch(source, /configureScenarioRelationships|showQuickPick\(choices/u);
    for (const command of [
        'toggleTestManagerRelationshipHighlight',
        'toggleTestManagerRelationshipHighlightChecked',
        'toggleTestManagerRelationshipFilter',
        'toggleTestManagerRelationshipFilterChecked',
        'toggleStepLibraryRelationshipHighlight',
        'toggleStepLibraryRelationshipHighlightChecked',
        'toggleStepLibraryRelationshipFilter',
        'toggleStepLibraryRelationshipFilterChecked'
    ]) {
        assert.match(source, new RegExp(`registerCommand\\(\\s*'kotTestToolkit\\.${command}'`, 'u'));
    }
    assert.match(source, /relationshipPresentation\.toggleMode\('stepLibrary',\s*'filter'\)/u);
});

test('activation owns one persistent Test Manager status filter and mutually exclusive contexts', () => {
    assert.match(source, /new TestManagerStatusFilterService\(context\.workspaceState\)/u);
    assert.match(source, /context\.subscriptions\.push\(testManagerStatusFilter\)/u);
    for (const suffix of ['All', 'AllChecked', 'Built', 'BuiltChecked', 'Running', 'RunningChecked']) {
        assert.match(
            source,
            new RegExp(`registerCommand\\(\\s*'kotTestToolkit\\.setTestManagerStatusFilter${suffix}'`, 'u')
        );
    }
    for (const [suffix, mode] of [['All', 'all'], ['Built', 'built'], ['Running', 'running']]) {
        assert.match(
            source,
            new RegExp(`setContext'[\\s\\S]*?testManagerStatusFilter${suffix}[\\s\\S]*?mode === '${mode}'`, 'u')
        );
    }
    assert.match(
        source,
        /testManagerFiltersActive[\s\S]*relationshipPresentation\.isActive\('testManager'\)[\s\S]*testManagerStatusFilter\.isActive\(\)/u
    );
    assert.match(source, /testManagerStatusFilter\.onDidChangeMode/u);
});

test('activation defers scenario creation and settings commands', () => {
    assert.doesNotMatch(source, /from '\.\/scenarioCreator';/);
    assert.match(source, /createDeferredLoader\(\s*\(\) => import\('\.\/scenarioCreator\.js'\)\s*\)/);
});

test('completion and hover defer the YAML parameters manager', () => {
    for (const providerSource of [completionProviderSource, hoverProviderSource]) {
        assert.doesNotMatch(providerSource, /from '\.\/yamlParametersManager';/);
        assert.match(providerSource, /import\('\.\/yamlParametersManager\.js'\)/);
    }
});

test('activation shares one project definition resolver across language providers', () => {
    assert.equal(source.match(/new StepCatalogService\(/g)?.length, 1);
    assert.equal(source.match(/new ProjectDefinitionResolver\(/g)?.length, 1);
    assert.match(
        source,
        /new DriveCompletionProvider\(context,\s*projectDefinitionResolver\)/
    );
    assert.match(source, /new DriveHoverProvider\(\s*context,\s*projectDefinitionResolver,/);
    assert.match(source, /steps:\s*stepCatalogService/);
    assert.doesNotMatch(source, /completionProvider\.refreshSteps\(\)/);
    assert.doesNotMatch(source, /hoverProvider\.refreshSteps\(\)/);

    const refreshStart = source.indexOf('    const refreshGherkinStepsCommand = async () => {');
    const refreshEnd = source.indexOf('\n    };', refreshStart);
    assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
    const refreshSource = source.slice(refreshStart, refreshEnd);
    assert.equal(refreshSource.match(/stepCatalogService\.refresh\(/g)?.length, 1);
});

test('activation shares nested scenario categories with CodeLens and creation', () => {
    assert.match(source, /new ScenarioCategoryCodeLensProvider\(context\.extensionUri\)/);
    assert.match(
        source,
        /SCENARIO_CATEGORY_COMMAND,[\s\S]*?setScenarioCategoryCommand\(target,[\s\S]*?resolver:\s*projectDefinitionResolver/
    );
    assert.match(
        source,
        /handleCreateNestedScenario\(context,[\s\S]*?existingCategories:/
    );
    assert.equal(source.match(/new ScenarioCategoryCodeLensProvider\(/g)?.length, 1);
});

test('activation registers and disposes the complete project-definition graph before background start', () => {
    assert.equal(source.match(/createProjectDefinitionIndexService\(context\)/g)?.length, 1);
    assert.equal(source.match(/new ProjectDefinitionProvider\(/g)?.length, 1);
    assert.equal(source.match(/new ProjectDefinitionReferenceProvider\(/g)?.length, 1);
    assert.match(
        source,
        /context\.subscriptions\.push\(\s*projectDefinitionIndex,\s*projectDefinitionResolver,\s*projectDefinitionReferenceService\s*\)/
    );

    const definitionRegistration = source.indexOf('vscode.languages.registerDefinitionProvider(');
    const referenceRegistration = source.indexOf('vscode.languages.registerReferenceProvider(');
    const backgroundStart = source.indexOf('projectDefinitionIndex.start();');
    assert.ok(definitionRegistration >= 0);
    assert.ok(referenceRegistration >= 0);
    assert.ok(backgroundStart > definitionRegistration);
    assert.ok(backgroundStart > referenceRegistration);
    const ts = require(path.join(process.cwd(), 'node_modules', 'typescript')) as typeof import('typescript');
    const syntax = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.ES2022, true);
    const activation = syntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'activate');
    assert.ok(activation);
    const eagerIndexWaits: number[] = [];
    const inspect = (node: import('typescript').Node): void => {
        // Registered command callbacks may await the index when the user invokes them.
        if (node !== activation && ts.isFunctionLike(node)) { return; }
        if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)
            && ts.isPropertyAccessExpression(node.expression.expression)
            && node.expression.expression.name.text === 'ensureReady'
            && node.expression.expression.expression.getText(syntax) === 'projectDefinitionIndex') {
            eagerIndexWaits.push(node.pos);
        }
        ts.forEachChild(node, inspect);
    };
    inspect(activation);
    assert.deepEqual(eagerIndexWaits, []);
});

test('Form Explorer reuses the shared step catalog service without an HTML fetcher', () => {
    assert.match(source, /new FormExplorerPanel\(context, stepCatalogService(?:,|\))/);
    assert.doesNotMatch(formExplorerStepSuggestionsSource, /stepsFetcher|getStepsHtml/);
    assert.match(formExplorerStepSuggestionsSource, /catalogProvider\.getCatalog\(\)/);
});

test('phase switcher defers infobase management helpers', () => {
    assert.doesNotMatch(phaseSwitcherSource, /from '\.\/infobaseManager';/);
    assert.match(
        phaseSwitcherSource,
        /createDeferredLoader\(\s*\(\) => import\('\.\/infobaseManager\.js'\)\s*\)/
    );
});

test('activation defers Form Explorer and 1C platform infrastructure', () => {
    assert.doesNotMatch(source, /from '\.\/formExplorerBuilder';/);
    assert.doesNotMatch(source, /from '\.\/oneCPlatform';/);
    assert.match(source, /import\('\.\/formExplorerBuilder\.js'\)/);
    assert.match(source, /import\('\.\/oneCPlatform\.js'\)/);
});

test('phase switcher defers optional 1C runtime infrastructure', () => {
    assert.doesNotMatch(phaseSwitcherSource, /from '\.\/infobasePicker';/);
    assert.doesNotMatch(
        phaseSwitcherSource,
        /import\s*\{\s*ensureSharedStartupInfobaseReady[\s\S]*?from '\.\/startupInfobase';/
    );
    assert.doesNotMatch(phaseSwitcherSource, /from '\.\/oneCPlatform';/);
    assert.match(phaseSwitcherSource, /import\('\.\/infobasePicker\.js'\)/);
    assert.match(phaseSwitcherSource, /import\('\.\/startupInfobase\.js'\)/);
    assert.match(phaseSwitcherSource, /import\('\.\/oneCPlatform\.js'\)/);
});

test('phase switcher starts background log monitoring only after its view opens', () => {
    assert.doesNotMatch(phaseSwitcherConstructorSource, /startVanessaRuntimeLogMonitor\(\)/);
    assert.match(
        phaseSwitcherResolveWebviewSource,
        /_vanessaRuntimeLogMonitorEnabled = true;\s*this\.startVanessaRuntimeLogMonitor\(\)/
    );
    assert.match(
        phaseSwitcherSource,
        /startVanessaRuntimeLogMonitor\(\): void \{\s*if \(!this\._vanessaRuntimeLogMonitorEnabled\)/
    );
});

test('phase switcher creates its build output channel on demand', () => {
    assert.doesNotMatch(
        phaseSwitcherConstructorSource,
        /createOutputChannel\(["']KOT Test Assembly["']\)/
    );
});

test('run log analyzers read only the requested file tail', () => {
    assert.equal(
        phaseSwitcherSource.match(/readFileTailSync\(runLogPath, startOffset \?\? 0\)/g)?.length,
        2
    );
    assert.doesNotMatch(phaseSwitcherSource, /fs\.readFileSync\(runLogPath\)/);
});

test('scenario runtime consumers do not recreate the legacy name-keyed cache', () => {
    for (const providerSource of [phaseSwitcherSource, hoverProviderSource]) {
        assert.doesNotMatch(providerSource, /_testCache|getTestCache\(|primaryByName/);
        assert.match(providerSource, /getScenarioCatalog\(|ensureFreshScenarioCatalog\(/);
    }
});

test('runtime watcher timers poll through each record current URI key', () => {
    assert.match(phaseSwitcherSource, /pollFeatureStepTracker\(tracker\.scenarioKey\)/);
    assert.match(phaseSwitcherSource, /pollLiveRunLogWatcher\(watcher\.scenarioKey\)/);
    assert.match(phaseSwitcherSource, /pollTrackedRunLogWatcher\(tracker\.scenarioKey, runLogKey\)/);
});

test('scenario rename publishes the new catalog before remapping runtime URI keys', () => {
    const start = phaseSwitcherSource.indexOf('    private async handleScenarioFilesRenamed(');
    const end = phaseSwitcherSource.indexOf('    private publishScenarioCatalog(', start);
    const renameSource = phaseSwitcherSource.slice(start, end);

    assert.ok(start >= 0 && end > start);
    assert.ok(renameSource.indexOf('await this.updateScenarioCacheEntriesForRenames(files)') >= 0);
    assert.ok(
        renameSource.indexOf('await this.updateScenarioCacheEntriesForRenames(files)')
            < renameSource.indexOf('resolveConfirmedScenarioRuntimeRenames(')
    );
    assert.match(renameSource, /applyMainScenarioSelectionRenamePlan\([\s\S]*?renamePlan/);
    assert.match(renameSource, /applyScenarioCustomInfobaseRenamePlan\([\s\S]*?renamePlan/);
    assert.match(renameSource, /applyScenarioRuntimeRenamePlan\(renamePlan/);
    assert.doesNotMatch(
        phaseSwitcherSource.slice(
            phaseSwitcherSource.indexOf('    private applyScenarioRuntimeRenamePlan('),
            phaseSwitcherSource.indexOf('    private async getMainScenarioSelectionSnapshotForBuild(')
        ),
        /_scenarioBuildArtifacts\.size === 0/
    );
});

test('current build binds duplicate-name artifacts through the exact enabled URI projection', () => {
    assert.match(
        phaseSwitcherSource,
        /updateScenarioBuildArtifacts\(\s*featureFiles,\s*featureFileDirUri,\s*selectionSnapshot\.enabledKeyByName/
    );
    assert.match(
        phaseSwitcherSource,
        /temporarilyMoveDisabledScenarioTestFilesForBuild\([\s\S]*?scenarioSelection\.isolatedDisabledKeys/
    );
});

test('demo state picker sends the selected scenario exact URI key', () => {
    assert.match(
        phaseSwitcherSource,
        /command: 'setDemoState',[\s\S]*?key: scenarioPick\.scenarioKey/
    );
});
