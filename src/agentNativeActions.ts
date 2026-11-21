import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentAction, AgentActionPorts } from './agentActions';
import { AgentWorkspace, agentHash } from './agentWorkspace';
import { agentString } from './agentTools';
import { buildFeatureEditorActions, getFeatureStepTagAction } from './featureEditorActions';
import { buildExportScenarioMetadataActions } from './exportScenarioMetadata';
import { parseStandaloneFeatureSource } from './standaloneFeatureModel';
import * as bases from './infobaseManager';
import type { ManagedInfobaseService } from './managedInfobaseService';
import type { PhaseSwitcherProvider } from './phaseSwitcher';
import type { StandaloneFeatureService } from './standaloneFeatureService';
import type { VanessaControlSession } from './vanessaControlSession';
import type { StepLibrarySnapshotService } from './stepLibrarySnapshotService';
import type { StepLibraryActionService } from './stepLibraryActions';
import type { StepLibraryFavoritesService } from './stepLibraryFavorites';
import type { ScenarioFilesService } from './scenarioFilesService';
import { VanessaDebugClientStore, type VanessaDebugClient } from './vanessaDebugClients';
import { loadKotSettingsModel } from './kotSettingsModel';
import type { SettingsChange } from './kotSettingsSession';
import { createWorkspaceSettingsSession } from './kotWorkspaceConfiguration';
import type { ScenarioPropertiesPanel } from './scenarioPropertiesPanel';
import { resolveScenarioSourceUris } from './spprScenarioFiles';
import { YamlParametersManager } from './yamlParametersManager';
import { projectLibraryEnvironment, assertProjectMetadataSaved } from './projectLibraryIntegration';
import { createProjectLibraryStore } from './projectLibraryMetadata';
import { ProjectGroupDisplayOrder } from './projectGroupDisplayOrder';
import type { ProjectLibrarySnapshot } from './projectLibraryStore';
import type { InfobaseManagerPanel } from './infobaseManagerPanel';
import { ensureOneCPlatformsCatalogInitialized } from './oneCPlatform';
import { scenarioFilesAvailable, scenarioFilesItemForResource } from './scenarioFilesModel';
import type { VanessaAuthoringCommands } from './vanessaControlAuthoringCommands';
import type { ProjectDefinitionResolver } from './projectDefinitionResolver';
import type { ProjectDefinitionReferenceService } from './projectDefinitionReferences';
import { agentReferences, agentCallGraph } from './agentDefinitionQueries';
import { agentUiCommands, canonicalAgentCommand, agentUserCommands, agentInternalCommands } from './agentUiCommands';

export interface AgentNativeDependencies {
    context: vscode.ExtensionContext; workspace: AgentWorkspace; provider: PhaseSwitcherProvider;
    standalone: StandaloneFeatureService; session: VanessaControlSession; infobases: ManagedInfobaseService;
    snapshots: StepLibrarySnapshotService; library: StepLibraryActionService; favorites: StepLibraryFavoritesService; files: ScenarioFilesService;
    properties(): ReturnType<ScenarioPropertiesPanel['createApiControllers']>;
    infobasePreferences(input?: Parameters<InfobaseManagerPanel['apiPreferences']>[0]): Promise<unknown>;
    authoring?: VanessaAuthoringCommands;
    definitions?: ProjectDefinitionResolver;
    references?: ProjectDefinitionReferenceService;
    uiState?(): unknown;
}
type Input = Record<string, unknown>;
type Fields = Record<string, Record<string, unknown>>;
const text = agentString(); const boolean = { type: 'boolean' }; const integer = { type: 'integer', minimum: 0, maximum: 10_000_000 };
const array = (items: Record<string, unknown>, maxItems = 500) => ({ type: 'array', items, maxItems });
const object = (properties: Fields, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const choice = (...values: string[]) => ({ type: 'string', enum: values });
const propertyValue = { type: 'string', maxLength: 64000 };
const propertyTarget = { section: text, field: text, recordKey: text, stepUid: text, beforeRecordKey: { anyOf: [text, { type: 'null' }] } };
const propertyMessage = object({
    command: choice('action', 'edit', 'editMetadata', 'addRecord', 'removeRecord', 'moveRecord', 'createChoice', 'catalogChoice', 'fillProcessDefaults', 'featureAction'),
    action: choice('save', 'pin', 'openSource', 'openFeature', 'openText', 'openSettings', 'openMetadata', 'copyPath', 'rename', 'changeCode',
        'systemFunction', 'base', 'users', 'addSteps', 'changeGroup', 'newGroup', 'createSettings', 'selectSettings', 'addNested', 'openReference',
        'fillParameters', 'fillNested', 'dismissError', 'favorite', 'convertFormat', 'convertRole', 'convertCallable', 'run',
        'edit', 'structure', 'openScenario', 'renameScenario', 'group', 'chooseJson', 'generateJson', 'openJson', 'convertExport'),
    documentUri: text, documentVersion: integer, sourceVersion: integer, uri: text, version: integer, line: integer,
    field: text, value: propertyValue, baseValue: propertyValue,
    target: object(propertyTarget, ['section']), edit: object({ ...propertyTarget, value: propertyValue }, ['section', 'field', 'value'])
}, ['command']);

/** Adapters share KOT's native services and wizards; command IDs never come from the caller. */
export function createAgentNativeActions(deps: AgentNativeDependencies): AgentActionPorts {
    const { context, workspace, provider, standalone, session } = deps;
    const actions = new Map<string, { descriptor: AgentAction; run(input: Input): Promise<unknown> }>();
    const commandActions = new Map<string, string>();
    let selectedBaseRoot: string | undefined;
    const add = (id: string, domain: string, description: string, fields: Fields, required: string[], run: (input: Input) => Promise<unknown>, mutates = true, execution = false, destructive = false, interrupts = false) => {
        if (actions.has(id)) { throw new Error('Duplicate KOT action: ' + id); }
        actions.set(id, { descriptor: { id, domain, description, inputSchema: object(fields, required), mutates, execution, destructive, interrupts }, run });
    };
    const refresh = async () => {
        await provider.refreshFromExternalStateChange({ refreshCache: true }); await standalone.refresh(); deps.snapshots.invalidate();
        await vscode.commands.executeCommand('kotTestToolkit.refreshInfobaseSidebar');
    };
    const source = async (input: Input) => {
        const uri = vscode.Uri.file(await workspace.resolve(input.source as string));
        if (vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString() && document.isDirty)) { throw new Error('Save the source before a native action.'); }
        return uri;
    };
    const selectEditor = async (input: Input) => {
        const uri = await source(input); const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        const line = input.line as number ?? 0; const end = input.endLine as number ?? line;
        const character = input.character as number ?? 0; const endCharacter = input.endCharacter as number ?? document.lineAt(Math.min(end, document.lineCount - 1)).text.length;
        if (line >= document.lineCount || end >= document.lineCount || end < line || character > document.lineAt(line).text.length
            || endCharacter > document.lineAt(end).text.length || line === end && endCharacter < character) { throw new Error('Select existing source lines.'); }
        editor.selection = new vscode.Selection(line, character, end, endCharacter);
        if (vscode.window.activeTextEditor?.document.uri.toString() !== uri.toString()) { throw new Error('The active editor changed. Retry with the intended source.'); }
        return uri;
    };
    const commands: Array<[string, string, string, boolean?, boolean?]> = [
        ['scenario.create_main', 'createMainScenario', 'Create a main SPPR scenario using native defaults, UID, numbering and launch-settings wizard.'],
        ['scenario.create_nested', 'createNestedScenario', 'Create a nested SPPR scenario using native defaults, UID and numbering.'],
        ['scenario.create_process', 'createProcess', 'Create a main process and its launch settings.'],
        ['scenario.create_nested_process', 'createNestedProcess', 'Create a nested process.'],
        ['scenario.create_feature', 'createFeature', 'Create a standalone feature using the native wizard.'],
        ['scenario.create_export', 'createExportScenario', 'Create an exported scenario and its parameters.'],
        ['library.create_step', 'createUserStep', 'Create a BSL user step with the native library wizard.'],
        ['library.build', 'buildUserStepLibrary', 'Build a user-step EPF library.', true, true],
        ['library.dump', 'dumpUserStepLibrary', 'Dump EPF library sources through Designer.', true, true],
        ['library.manage', 'manageUserStepLibraries', 'Manage configured user-step libraries.'],
        ['scenario.rename', 'renameScenarioFromEditor', 'Rename a scenario with native reference and settings updates.', true],
        ['scenario.change_code', 'changeNestedScenarioCode', 'Change scenario code and associated files through native checks.', true],
        ['scenario.rename_process', 'renameProcessFromEditor', 'Rename a process and update supported references.', true],
        ['scenario.change_process_code', 'changeProcessCodeFromEditor', 'Change process code and associated files.', true],
        ['scenario.process_steps', 'editProcessSteps', 'Edit process steps, parameters and ordering.', true],
        ['scenario.add_process_steps', 'addProcessSteps', 'Add scenarios or subprocesses to a process.', true],
        ['scenario.convert_format', 'convertScenarioFormat', 'Convert YAML and native feature+meta preserving identity and attachments.', true],
        ['scenario.convert_role', 'convertScenarioRole', 'Convert a main/nested scenario or process with launch-settings checks.', true],
        ['scenario.convert_callable', 'convertCallableScenario', 'Convert nested/exported scenarios with supported caller rewrites.', true],
        ['scenario.convert_batch', 'convertScenarioFormatsBatch', 'Batch-convert scenarios with per-file conflict checks.'],
        ['scenario.change_group', 'changeScenarioGroup', 'Assign a scenario to a group using the native metadata writer.', true],
        ['scenario.link_settings', 'changeProcessTestSettingsFromEditor', 'Change linked process launch settings.', true],
        ['scenario.feature_json', 'generateFeatureJson', 'Generate and attach launch JSON to a feature.', true],
        ['scenario.fill_calls', 'checkAndFillNestedScenarios', 'Check and fill nested scenario references.', true],
        ['scenario.fill_parameters', 'checkAndFillScriptParameters', 'Check and fill script parameters.', true],
        ['project.numbering', 'manageTestNumbering', 'Manage author numbering series using the native catalog.'],
        ['project.system_functions', 'manageSystemFunctions', 'Manage system functions and their UIDs.'],
        ['project.etalon_bases', 'manageEtalonBases', 'Manage reference bases and their user profiles.'],
        ['project.platforms', 'managePlatforms', 'Manage installed/configured 1C platforms.'],
        ['project.resolve_metadata', 'resolveMetadataConflicts', 'Resolve metadata conflicts with native checks.'],
        ['project.diagnostics', 'scanWorkspaceDiagnostics', 'Scan workspace diagnostics.', false],
        ['project.repair', 'fixScenarioIssues', 'Run native scenario repair for the selected saved source.', true],
        ['project.step_catalog', 'generateLocalStepCatalog', 'Generate the offline local Vanessa step catalog.'],
        ['project.export_compiler', 'exportSpprCompiler', 'Export the SPPR compiler through native preparation.', false, true],
        ['project.first_launch_zip', 'createFirstLaunchZip', 'Create a FirstLaunch ZIP using the native version handling.'],
        ['project.repair_changed', 'processQueuedScenarioFiles', 'Repair the native pending/Git-modified scenario batch with progress and cancellation.'],
        ['project.repair_all', 'processAllScenarioFiles', 'Repair all scenario files through native validation and rollback.'],
        ['debug.breakpoints', 'vanessaControl.listBreakpoints', 'Read breakpoints for the selected source.', true],
        ['debug.toggle_breakpoint', 'vanessaControl.toggleBreakpoint', 'Toggle a breakpoint at the selected source line.', true, true],
        ['debug.resume', 'vanessaControl.resume', 'Continue the confirmed breakpoint stop.', true, true],
        ['debug.selection', 'vanessaControl.runSelection', 'Execute the selected source lines.', true, true],
        ['debug.try_yaml', 'vanessaControl.tryYamlStep', 'Probe the selected YAML step through native source mapping.', true, true],
        ['debug.one_compiled_step', 'vanessaControl.oneCompiledStep', 'Run one compiled step using the native mapping.', true, true],
        ['debug.delete_variable', 'vanessaControl.variables.delete', 'Delete a variable through the native variable controller.', false, true],
        ['debug.runtime_search', 'vanessaControl.searchRuntimeSteps', 'Search the runtime step catalog.', false, true],
        ['debug.runtime_syntax', 'vanessaControl.checkRuntimeSyntax', 'Check runtime syntax.', true, true],
        ['debug.track_log', 'trackScenarioRunFromOpenedLogFile', 'Attach tracking to the selected external execution log.', true],
        ['debug.track_feature', 'trackScenarioRunByFeatureLog', 'Attach an external log to the selected feature.', true],
        ['debug.tracking_switch', 'switchTrackedScenarioRunForFeature', 'Select an existing tracked run for the feature.', true],
        ['debug.tracking_stop', 'stopTrackedScenarioRunForFeature', 'Stop log tracking for this feature; does not stop the external test.', true],
        ['debug.record_start', 'vanessaControl.recording.start', 'Start recording into an explicitly selected source.', true, true],
        ['debug.record_stop', 'vanessaControl.recording.stop', 'Stop recording and retain captured steps.', false, true],
        ['debug.record_insert', 'vanessaControl.recording.insertHere', 'Insert captured steps at the selected source line.', true, true],
        ['debug.form_checks', 'vanessaControl.formChecks', 'Capture checks for the current form.', false, true],
        ['debug.form_suggestions', 'vanessaControl.formSuggestions', 'Capture action suggestions for the current form.', false, true]
    ];
    for (const [id, command, description, editor = false, execution = false] of commands) {
        commandActions.set('kotTestToolkit.' + command, id);
        const fields: Fields = editor ? { source: text, line: integer, endLine: integer, character: integer, endCharacter: integer } : {};
        add(id, id.split('.')[0], description + ' Wizard questions are available through kot_action_question/answer.', fields, editor ? ['source'] : [], async input => {
            const creating = id.startsWith('scenario.create_') || id === 'library.create_step';
            const before = creating ? new Set((await deps.snapshots.ensureReady()).items.map(item => item.id)) : undefined;
            const uri = editor ? await selectEditor(input) : undefined;
            if (!(await vscode.commands.getCommands(true)).includes('kotTestToolkit.' + command)) { throw new Error('The native command is not registered in this KOT host: ' + command); }
            const result = await vscode.commands.executeCommand('kotTestToolkit.' + command, ...(uri ? [uri] : []));
            if (result === false) { throw new Error('The native command did not complete. Inspect its notifications.'); }
            await refresh();
            const created = before ? (await deps.snapshots.ensureReady()).items.filter(item => !before.has(item.id))
                .map(item => ({ id: item.id, template: item.template, kind: item.kind, location: item.capturedLocation, featureId: item.featureId })) : undefined;
            return { ...(result && typeof result === 'object' && 'fsPath' in result ? { path: result.fsPath } : { commandReturned: true, result: result ?? null }),
                ...(created ? { created, descriptionRequired: true } : {}) };
        }, !['debug.breakpoints', 'project.diagnostics', 'debug.runtime_search', 'debug.runtime_syntax'].includes(id), execution);
    }
    for (const operation of ['stop', 'detach'] as const) {
        add('debug.' + operation, 'debug', operation === 'stop' ? 'Request the attached Vanessa execution to stop. Inspect runtime until confirmed.'
            : 'Detach KOT from Vanessa without closing Vanessa. Active execution becomes unconfirmed.', {}, [], async () => {
            await session[operation](); return session.snapshot;
        }, true, true, false, true);
    }
    add('debug.record_read', 'debug', 'Read the shared recording/generated-step buffer, including the last result after insertion. Does not start, stop or consume it.', {}, [], async () => {
        if (!deps.authoring) { throw new Error('Authoring is unavailable in this host.'); } return deps.authoring.read();
    }, false);
    add('scenario.references', 'scenario', 'Find references using the same project definition resolver and complete saved-source scan as native refactoring. Zero-based locations; paginated.', {
        source: text, definitionId: text, offset: integer, limit: { type: 'integer', minimum: 1, maximum: 200 }
    }, ['source'], async input => agentReferences(deps, workspace, await source(input), input), false);
    add('scenario.call_graph', 'scenario', 'Expand source calls recursively with native argument matching, ambiguity and cycles. Bounded static graph; conditions are not execution evidence.', {
        source: text, depth: { type: 'integer', minimum: 0, maximum: 30 }, limit: { type: 'integer', minimum: 1, maximum: 1000 }
    }, ['source'], async input => agentCallGraph(deps, workspace, await source(input), input), false);
    add('ui.state', 'ui', 'Read the actual native filters, relationship presentation and scenario repair state.', {}, [], async () => deps.uiState?.() ?? {}, false);
    const openSourceDocument = async (input: Input) => vscode.workspace.openTextDocument(vscode.Uri.file(await workspace.resolve(input.source as string)));
    add('feature.editor_read', 'scenario', 'Read native feature structure and export metadata actions with current revision. Optional stepLine discovers a step annotation target.', {
        source: text, stepLine: integer
    }, ['source'], async input => {
        const uri = await source(input); const document = await vscode.workspace.openTextDocument(uri); const value = document.getText();
        const featureSource = { text: value, uri: uri.toString(), version: document.version, language: parseStandaloneFeatureSource(value, '').language };
        return { revision: agentHash(value), structure: buildFeatureEditorActions(featureSource),
            step: input.stepLine === undefined ? undefined : getFeatureStepTagAction(featureSource, input.stepLine as number),
            metadata: buildExportScenarioMetadataActions({ text: value, sourceUri: uri.toString(), version: document.version,
                workspaceFolderUri: vscode.Uri.file(workspace.root).toString(), profileId: '', libraryRootUri: '', sourceLabel: 'Project exports', defaultLanguage: featureSource.language }) };
    }, false);
    add('feature.structure', 'scenario', 'Invoke a current native feature structure/step annotation action. Read feature.editor_read first; inspect and save the resulting buffer explicitly.', {
        source: text, expectedRevision: text, line: integer,
        kind: choice('description', 'background', 'variables', 'tags', 'tree', 'outline', 'examples', 'variable', 'stepTag', 'scenario'),
        stepLine: integer, scenarioKind: choice('scenario', 'outline'), scenarioTitle: text,
        stepTag: choice('screenshot', 'recordvideo', 'StopRecordVideo', 'StartRecordVideo')
    }, ['source', 'expectedRevision', 'line', 'kind'], async input => {
        const uri = await source(input); const document = await vscode.workspace.openTextDocument(uri);
        if (agentHash(document.getText()) !== input.expectedRevision) { throw new Error('Feature changed. Read feature.editor_read again.'); }
        if (input.kind === 'stepTag' && input.stepLine === undefined) { throw new Error('Step annotations require the actual stepLine.'); }
        await vscode.commands.executeCommand('kotTestToolkit.editFeatureStructure', { uri: uri.toString(), version: document.version, line: input.line, kind: input.kind },
            { stepLine: input.stepLine, scenarioKind: input.scenarioKind, scenarioTitle: input.scenarioTitle, stepTag: input.stepTag });
        return { commandReturned: true };
    });
    add('feature.export_metadata', 'scenario', 'Invoke a current native export metadata action. Uses its declaration position and a guarded source revision; values use native dialogs.', {
        source: text, expectedRevision: text, line: integer, character: integer, kind: choice('category', 'description', 'usageExample')
    }, ['source', 'expectedRevision', 'line', 'character', 'kind'], async input => {
        const uri = await source(input); const document = await vscode.workspace.openTextDocument(uri);
        if (agentHash(document.getText()) !== input.expectedRevision) { throw new Error('Feature changed. Read feature.editor_read again.'); }
        await vscode.commands.executeCommand('kotTestToolkit.addExportScenarioMetadata', { documentUri: uri.toString(), documentVersion: document.version,
            scenarioStart: { line: input.line, character: input.character }, kind: input.kind });
        return { commandReturned: true };
    });
    add('ui.source_state', 'ui', 'Read the editor buffer, saved/dirty state and revision after native editor commands. Does not save or discard changes.', { source: text }, ['source'], async input => {
        const document = await openSourceDocument(input); const text = document.getText();
        return { source: document.uri.fsPath, version: document.version, dirty: document.isDirty, revision: agentHash(text), text };
    }, false);
    add('ui.save_source', 'ui', 'Save an explicitly selected editor buffer only if its current text matches expectedRevision from ui.source_state. Does not discard newer edits.', {
        source: text, expectedRevision: text
    }, ['source', 'expectedRevision'], async input => {
        const document = await openSourceDocument(input);
        if (agentHash(document.getText()) !== input.expectedRevision) { throw new Error('Editor buffer changed. Read ui.source_state again.'); }
        if (!await document.save() || document.isDirty) { throw new Error('Could not save the selected editor buffer.'); }
        return { source: document.uri.fsPath, version: document.version, dirty: document.isDirty, revision: agentHash(document.getText()) };
    });
    add('scenario.parameter_default', 'scenario', 'Edit a named scenario parameter default through the native validated editor dialog.', {
        source: text, parameter: text
    }, ['source', 'parameter'], async input => {
        const uri = await source(input);
        await vscode.commands.executeCommand('kotTestToolkit.editScenarioParameterDefaultValue', uri.toString(), input.parameter);
        return { source: uri.fsPath };
    });
    add('ui.open_scenario', 'ui', 'Open a scenario by its actual name using the native ambiguity picker.', { name: text }, ['name'], async input => {
        await vscode.commands.executeCommand('kotTestToolkit.openScenarioByName', input.name); return { commandReturned: true };
    }, false);
    for (const [id, command] of [['open_run_log', 'openRunScenarioLog'], ['open_failed_source', 'openFailedNestedScenarioFromRun']] as const) {
        add('debug.' + id, 'debug', 'Open the native run artifact for an exact scenario name/key; optional failure line is one-based. Disambiguation remains native.', { name: text, scenarioKey: text, source: text, line: { type: 'integer', minimum: 1 } }, ['name'], async input => {
            const file = input.source ? await source(input) : undefined;
            await vscode.commands.executeCommand('kotTestToolkit.' + command, input.name, input.scenarioKey,
                file && input.line ? { featurePath: file.fsPath, lineNumber: input.line } : undefined);
            return { commandReturned: true };
        }, false);
    }
    add('project.repair_cancel', 'project', 'Request cancellation of a native scenario repair batch started in the UI. For an agent action use kot_action_cancel with its operation ID.', {}, [], async () => {
        await vscode.commands.executeCommand('kotTestToolkit.cancelScenarioRepair'); return deps.uiState?.();
    }, false, false, false, true);
    add('debug.diagnostics_read', 'debug', 'Collect structured native Vanessa diagnostics with optional manager/client logs. Unavailable sections stay explicit.', {
        managerLog: boolean, clientLog: boolean
    }, [], async input => session.withDiagnosticControl(diagnostics => diagnostics.collect(input)), false);
    add('debug.element_checks', 'debug', 'Generate checks for one real form element/table and return the shared generated-step buffer.', {
        element: text, table: text
    }, [], async input => {
        if (!session.snapshot.capabilities?.elementSteps?.supported) { throw new Error('The attached Vanessa session does not support element checks. Inspect kot_runtime.'); }
        await vscode.commands.executeCommand('kotTestToolkit.vanessaControl.elementChecks', input.element, input.table);
        return deps.authoring?.read();
    }, false, true);
    for (const spec of agentUiCommands) {
        const id = 'ui.' + spec.command; commandActions.set('kotTestToolkit.' + spec.command, id);
        add(id, 'ui', 'Invoke the native ' + spec.command + ' UI entry point. Questions use the action question/answer protocol; no arbitrary commands or arguments.',
            spec.editor ? { source: text, line: integer, endLine: integer, character: integer, endCharacter: integer } : {}, spec.editor ? ['source'] : [], async input => {
                const uri = spec.argument ? vscode.Uri.file(await workspace.resolve(input.source as string)) : spec.editor ? await selectEditor(input) : undefined;
                if (!(await vscode.commands.getCommands(true)).includes('kotTestToolkit.' + spec.command)) { throw new Error('Native UI command is not registered: ' + spec.command); }
                const result = await vscode.commands.executeCommand('kotTestToolkit.' + spec.command,
                    ...(spec.argument === 'uri' ? [uri] : spec.argument === 'path' ? [uri!.fsPath] : []));
                return { result: result ?? null, state: deps.uiState?.(), ...(spec.command === 'vanessaControl.recording.copy' ? { buffer: deps.authoring?.read() } : {}) };
            }, spec.mutates === true, spec.execution === true);
    }
    const replacements: Record<string, string> = {
        createInfobase: 'infobase.create', convertScenario: 'scenario.convert_role', runFeature: 'kot_run_start',
        runTestFromSource: 'kot_run_start', openScenarioByName: 'ui.open_scenario', editScenarioParameterDefaultValue: 'scenario.parameter_default',
        openRunScenarioLog: 'debug.open_run_log', openFailedNestedScenarioFromRun: 'debug.open_failed_source', refreshPhaseSwitcherFromCreate: 'ui.refreshPhaseSwitcher',
        openFormExplorerForInfobase: 'infobase.form_explorer', openVanessaForInfobase: 'infobase.vanessa_client',
        editFeatureStructure: 'feature.structure', addExportScenarioMetadata: 'feature.export_metadata',
        'vanessaControl.stop': 'debug.stop', 'vanessaControl.detach': 'debug.detach', 'vanessaControl.elementChecks': 'debug.element_checks',
        cancelScenarioRepair: 'project.repair_cancel', 'agent.run': 'kot_run_start', 'agent.importCi': 'kot_ci_import', 'agent.story': 'kot_task_create', 'agent.report': 'kot_report'
    };
    add('ui.commands', 'ui', 'Audit every contributed KOT command and menu alias against its agent action/tool or explicit native-user control. Unknown entries are reported as unmapped.', {}, [], async () => {
        const manifest = JSON.parse(await fs.readFile(path.join(context.extensionPath, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string }> } };
        const registered = (await vscode.commands.getCommands(true)).filter(command => command.startsWith('kotTestToolkit.'));
        return [...new Set([...manifest.contributes.commands.map(value => value.command), ...registered])].map(command => {
            const canonical = canonicalAgentCommand(command); const name = canonical.replace(/^kotTestToolkit\./u, '');
            const action = commandActions.get(canonical) ?? replacements[name]; const userControl = agentUserCommands[name]; const internal = agentInternalCommands[name];
            return { command, canonical, action, userControl, internal, status: action ? 'available' : userControl ? 'user_control' : internal ? 'internal' : 'unmapped' };
        });
    }, false);
    add('infobase.list', 'infobase', 'List actual KOT/launcher bases, including hidden records. Credentials and launch keys are omitted.', {}, [], async () => {
        const snapshot = await deps.infobases.refresh();
        return snapshot.infobases.map(base => ({ id: base.id, name: base.displayName, launcherName: base.launcherName, kind: base.infobaseKind,
            path: base.infobaseKind === 'file' ? base.infobasePath : undefined, state: base.state, hidden: base.hidden, roles: base.roles, sources: base.sources }));
    }, false);
    add('infobase.preferences_read', 'infobase', 'Read native manager sort order and hidden-record display preference.', {}, [], async () => deps.infobasePreferences(), false);
    add('infobase.preferences_set', 'infobase', 'Save native manager sort order/visibility with the current preferences revision. manualIds contains every listed base ID once.', {
        expectedRevision: text, sortMode: choice('alphabetical', 'lastOpened', 'manual'), showHidden: boolean, manualIds: array(text)
    }, ['expectedRevision'], async input => deps.infobasePreferences(input as Parameters<InfobaseManagerPanel['apiPreferences']>[0]));
    const baseOperations: Array<[string, (context: vscode.ExtensionContext, base: bases.ManagedInfobaseRecord) => Promise<unknown>, boolean?, boolean?]> = [
        ['form_explorer', (_context, base) => Promise.resolve(vscode.commands.executeCommand('kotTestToolkit.openFormExplorerForInfobase', base.infobasePath)), true],
        ['vanessa_client', (_context, base) => Promise.resolve(vscode.commands.executeCommand('kotTestToolkit.openVanessaForInfobase', base.infobasePath)), true],
        ['rename', bases.renameInfobaseInteractive], ['move', bases.moveInfobaseInteractive, true, true],
        ['reassign', bases.reassignInfobasePathInteractive], ['delete', bases.deleteInfobaseInteractive, true, true],
        ['restore_dt', bases.restoreInfobaseFromDtInteractive, true, true], ['recreate', bases.recreateInfobaseInteractive, true, true],
        ['restore_template', (context, base) => bases.restoreInfobaseFromDtInteractive(context, base, 'template'), true, true],
        ['update_template', (context, base) => bases.updateInfobaseConfigurationInteractive(context, base, 'template'), true, true],
        ['update_sources', (context, base) => bases.updateInfobaseConfigurationInteractive(context, base, 'sourceDirectory'), true, true],
        ['update_cf', (context, base) => bases.updateInfobaseConfigurationInteractive(context, base, 'cfFile'), true, true],
        ['copy', bases.copyInfobaseInteractive, true], ['dump_dt', (context, base) => bases.exportInfobaseToDtInteractive(context, base.infobasePath), true],
        ['dump_cf', (context, base) => bases.exportInfobaseConfigurationToCfInteractive(context, base.infobasePath), true], ['update', bases.updateInfobaseConfigurationInteractive, true, true],
        ['register', bases.addInfobaseToLauncherInteractive], ['unregister', (context, base) => bases.removeInfobaseFromLauncherInteractive(base, context)],
        ['launch_keys', bases.configureInfobaseStartupParametersInteractive], ['open', bases.openInfobaseInEnterprise, true], ['designer', bases.openInfobaseInDesigner, true],
        ['logs', (_context, base) => bases.showInfobaseLogsInteractive(base)], ['edit', bases.editInfobaseInteractive],
        ['forget', (context, base) => bases.forgetManagedInfobase(context, base.infobasePath)],
        ['reveal', (_context, base) => bases.revealInfobaseInOs(base)]
    ];
    for (const [operation, run, execution = false, destructive = false] of baseOperations) {
        add('infobase.' + operation, 'infobase', 'Native infobase manager operation: ' + operation + '. Uses current infobaseId from infobase.list and preserves native checks/confirmations.', { infobaseId: text }, ['infobaseId'], async input => {
            const base = (await deps.infobases.refresh()).infobases.find(base => base.id === input.infobaseId);
            if (!base) { throw new Error('The infobase changed. Refresh infobase.list.'); }
            selectedBaseRoot = base.infobaseKind === 'file' ? base.infobasePath : undefined;
            try { const result = await run(context, base); await deps.infobases.refresh(); return result; }
            finally { selectedBaseRoot = undefined; }
        }, operation !== 'logs', execution, destructive);
    }
    add('infobase.create', 'infobase', 'Create a base using the full native wizard, including installed templates, target and launcher name.', {}, [], async () => {
        const result = await bases.createInfobaseInteractive(context); await deps.infobases.refresh(); return { path: result };
    }, true, true);
    add('infobase.add_path', 'infobase', 'Remember an existing allowed file base in KOT.', { path: text }, ['path'], async input => {
        const file = await workspace.resolve(input.path as string); await bases.rememberManualInfobase(context, file); await deps.infobases.refresh(); return { path: file };
    });
    for (const operation of ['hidden', 'platform'] as const) {
        add('infobase.' + operation, 'infobase', 'Set manager visibility or a preferred installed 1C client platform; an empty platform resets the preference.', {
            infobaseId: text, hidden: boolean, platformClientExePath: { type: 'string', maxLength: 4096 }
        }, ['infobaseId', operation === 'hidden' ? 'hidden' : 'platformClientExePath'], async input => {
            const base = (await deps.infobases.refresh()).infobases.find(value => value.id === input.infobaseId);
            if (!base) { throw new Error('Unknown infobase ID.'); }
            if (operation === 'hidden') { await bases.setManagedInfobaseHidden(context, base.infobasePath, input.hidden as boolean); }
            else {
                const platform = input.platformClientExePath as string;
                const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
                if (platform && !(await ensureOneCPlatformsCatalogInitialized()).some(item => key(item.clientExePath) === key(platform))) { throw new Error('Choose an installed/configured platform from project.platforms_read.'); }
                await bases.setManagedInfobasePreferredPlatformClientExePath(context, base.infobasePath, platform || null);
            }
            await deps.infobases.refresh(); return { saved: true };
        });
    }
    add('project.platforms_read', 'project', 'Read the native configured/installed platform catalog used by the infobase platform preference.', {}, [], async () => ensureOneCPlatformsCatalogInitialized(), false);
    add('clients.list', 'clients', 'Read saved client identities and revisions without passwords, full connection strings or launch keys.', {}, [], async () => {
        const clients = await new VanessaDebugClientStore(context.workspaceState, context.secrets).loadCatalog();
        return { revision: agentHash(JSON.stringify(clients)), clients: clients.map(({ id, name, username, synonym, clientType, computerName, port }) => ({ id, name, username, synonym, clientType, computerName, port })) };
    }, false);
    const clientFields = { id: text, name: text, infobase: text, username: { type: 'string', maxLength: 512 }, password: { type: 'string', maxLength: 4096 },
        synonym: { type: 'string', maxLength: 512 }, additionalParameters: { type: 'string', maxLength: 16000 }, clientType: choice('Thin', 'Thick', 'Web'), computerName: text,
        port: { type: 'integer', minimum: 1, maximum: 65535 }, expectedRevision: text };
    for (const operation of ['save', 'delete'] as const) {
        add('clients.' + operation, 'clients', 'Modify the saved client catalog with a current revision. Omitted password/launch keys are preserved. Secret fields stay in SecretStorage.', operation === 'save' ? clientFields : { id: text, expectedRevision: text }, operation === 'save' ? ['expectedRevision', 'name'] : ['id', 'expectedRevision'], async input => {
            await new VanessaDebugClientStore(context.workspaceState, context.secrets).updateCatalog(clients => {
                if (agentHash(JSON.stringify(clients)) !== input.expectedRevision) { throw new Error('Client catalog changed. Read clients.list again.'); }
                const existing = input.id ? clients.find(client => client.id === input.id) : undefined;
                if (input.id && !existing) { throw new Error('Unknown saved client ID.'); }
                if (operation === 'delete') { return clients.filter(client => client.id !== input.id); }
                const { expectedRevision: _revision, ...values } = input;
                const usedPorts = new Set(clients.filter(client => client.computerName.toLowerCase() === String(input.computerName ?? existing?.computerName ?? 'localhost').toLowerCase()).map(client => client.port));
                let port = 1538; while (usedPorts.has(port) && port < 65535) { port++; }
                const client = { id: randomUUID(), name: '', infobase: '', username: '', password: '', synonym: '', additionalParameters: '', clientType: 'Thin', computerName: 'localhost', port, ...existing, ...values } as VanessaDebugClient;
                return [...clients.filter(value => value.id !== client.id), client];
            });
            return { saved: true };
        });
    }
    add('settings.read', 'settings', 'Read KOT setting definitions, inherited values and revision tokens. Paginate or filter by key; secret values are hidden.', { scope: choice('user', 'workspace', 'folder'), query: text, offset: integer, limit: { type: 'integer', minimum: 1, maximum: 100 } }, [], async input => {
        const model = await loadKotSettingsModel(context.extensionPath, false); const scope = input.scope as 'workspace' ?? 'workspace';
        const values = createWorkspaceSettingsSession(model).snapshot(vscode.Uri.file(workspace.root).toString(), scope);
        const settings = model.settings.map((definition, index) => ({ ...definition, ...values[index] })).filter(item => !input.query || item.key.toLowerCase().includes(String(input.query).toLowerCase()));
        const offset = input.offset as number ?? 0; const limit = input.limit as number ?? 50;
        return { settings: settings.slice(offset, offset + limit), total: settings.length, nextOffset: offset + limit < settings.length ? offset + limit : undefined };
    }, false);
    add('settings.apply', 'settings', 'Apply schema-validated KOT settings through the shared settings session. Use key, scope and token from settings.read.', {
        changes: array(object({ key: text, scope: choice('user', 'workspace', 'folder'), token: text, reset: boolean, value: {} }, ['key', 'scope', 'token']), 100)
    }, ['changes'], async input => {
        if ((input.changes as SettingsChange[]).some(change => change.key.startsWith('kotTestToolkit.agent.'))) { throw new Error('Change agent permissions, roots and connection settings in the KOT Connect AI wizard or native Settings UI. The agent cannot grant itself access.'); }
        const model = await loadKotSettingsModel(context.extensionPath, false);
        const changes = (input.changes as SettingsChange[]).map(change => ({ ...change, folder: vscode.Uri.file(workspace.root).toString() }));
        return { applied: await createWorkspaceSettingsSession(model).apply(changes) };
    });
    for (const operation of ['read', 'apply'] as const) {
        add('properties.' + operation, 'properties', 'Read or edit the native scenario/process/feature property model, linked run settings, parameters, tags and metadata. Apply ONE validated native form message using versions and revision from read; saves and returns readback. Identity actions use native refactoring. Unsaved documents are rejected.', {
            source: text, settingsUri: text, expectedRevision: text, message: propertyMessage
        }, operation === 'read' ? ['source'] : ['source', 'expectedRevision', 'message'], async input => {
            let uri = await source(input);
            if (/(?:^|[\\/])(?:scen\.feature|meta\.yaml)$/u.test(uri.fsPath)) { uri = (await resolveScenarioSourceUris(uri))?.metadataUri ?? uri; }
            await workspace.resolve(uri.fsPath);
            const controllers = deps.properties();
            const isFeature = /\.feature$/iu.test(uri.fsPath);
            let state: unknown;
            if (isFeature) {
                if (!controllers.feature) { throw new Error('Feature properties are still initializing.'); }
                await controllers.feature.open(uri.toString()); state = controllers.feature.state;
            } else {
                state = await controllers.session.open(uri.toString());
                if (input.settingsUri) { state = await controllers.session.handle({ command: 'action', action: 'selectSettings', value: input.settingsUri }); }
            }
            const bound = isFeature ? [uri.toString()] : [controllers.session.getState().source?.uri, controllers.session.getState().source?.scriptUri,
                ...controllers.session.getState().settings.map(value => value.uri), controllers.session.getState().metadata?.uri].filter((value): value is string => !!value);
            for (const value of bound) {
                await workspace.resolve(vscode.Uri.parse(value, true).fsPath);
                if (vscode.workspace.textDocuments.some(document => document.uri.toString() === value && document.isDirty)) { throw new Error('Save the bound source/settings/metadata documents first.'); }
            }
            const revision = agentHash(JSON.stringify(state));
            if (operation === 'read') { return { revision, state }; }
            if (input.expectedRevision !== revision) { throw new Error('Properties changed. Read properties.read again.'); }
            const message = input.message as Record<string, unknown>;
            if (isFeature) {
                await controllers.feature!.handle(message);
                const current = controllers.feature!.state!;
                await controllers.feature!.handle({ command: 'featureAction', action: 'save', uri: current.uri, version: current.version });
                state = controllers.feature!.state;
            } else {
                const protocol = require('../media/scenarioPropertiesProtocol.js') as { validateMessage(message: unknown): boolean };
                if (!protocol.validateMessage(message)) { throw new Error('Invalid native properties message.'); }
                const changed = await controllers.session.handle(message);
                if (changed.error || changed.mutationError) { throw new Error(changed.error ?? 'The property edit failed.'); }
                state = await controllers.session.handle({ command: 'action', action: 'save' });
                if (controllers.session.getState().error) { throw new Error(controllers.session.getState().error); }
            }
            await refresh(); return { saved: true, revision: agentHash(JSON.stringify(state)), state };
        }, operation === 'apply', operation === 'apply');
    }
    add('profiles.read', 'profiles', 'Read build profiles and the active profile revision.', {}, [], async () => YamlParametersManager.getInstance(context).apiProfiles('read'), false);
    add('scenario.selection_read', 'scenario', 'Read sidebar main-test checkbox states. Execution/build tools also accept explicit tests without changing these preferences.', {}, [], async () => {
        const states = await provider.agentSelection(); return { revision: agentHash(JSON.stringify(states)), states };
    }, false);
    add('scenario.selection_set', 'scenario', 'Change selected sidebar main-test checkboxes with the current selection revision.', {
        expectedRevision: text, states: { type: 'object', additionalProperties: { type: 'boolean' } }
    }, ['expectedRevision', 'states'], async input => {
        const current = await provider.agentSelection();
        if (agentHash(JSON.stringify(current)) !== input.expectedRevision) { throw new Error('Selection changed. Read it again.'); }
        const states = await provider.agentSelection(current, input.states as Record<string, boolean>); return { revision: agentHash(JSON.stringify(states)), states };
    });
    for (const operation of ['select', 'create', 'duplicate', 'rename', 'delete', 'update'] as const) {
        add('profiles.' + operation, 'profiles', 'Manage build/Vanessa profiles with optimistic concurrency through the shared profile store.', {
            profileId: text, name: text, expectedRevision: text,
            buildParameters: array(object({ key: text, value: { type: 'string', maxLength: 32000 }, remove: boolean }, ['key'])),
            additionalVanessaParameters: array(object({ key: text, value: { type: 'string', maxLength: 32000 }, remove: boolean, overrideExisting: boolean, valueKind: choice('string', 'number', 'boolean', 'array', 'object', 'null') }, ['key'])),
            globalVanessaVariables: array(object({ key: text, value: { type: 'string', maxLength: 32000 }, remove: boolean, overrideExisting: boolean }, ['key']))
        }, ['expectedRevision'], async input => YamlParametersManager.getInstance(context).apiProfiles(operation, input));
    }
    add('groups.list', 'groups', 'Read project groups and metadata with a revision.', {}, [], async () => {
        const env = projectLibraryEnvironment(); const snapshot = await createProjectLibraryStore(workspace.root, env.workspaceRoots, env.scanRoots).readMetadata();
        const display = new ProjectGroupDisplayOrder(context.workspaceState);
        return { revision: agentHash(JSON.stringify(snapshot.groups)), ...snapshot,
            groupOrder: Object.fromEntries(['main', 'process', 'standalone'].map(section => [section, display.ordered(workspace.root, section as 'main', snapshot.groups).map(group => group.id)])) };
    }, false);
    for (const operation of ['create', 'rename', 'delete'] as const) {
        add('groups.' + operation, 'groups', 'Modify project groups through the shared metadata store. Requires the groups.list revision; shared group writes require the native supported project format.', { id: text, name: text, section: choice('main', 'process', 'standalone'), expectedRevision: text }, [...(operation === 'create' ? ['name', 'section'] : operation === 'rename' ? ['id', 'name'] : ['id']), 'expectedRevision'], async input => {
            const env = projectLibraryEnvironment(); const store = createProjectLibraryStore(workspace.root, env.workspaceRoots, env.scanRoots, assertProjectMetadataSaved);
            const check = (snapshot: ProjectLibrarySnapshot) => { if (agentHash(JSON.stringify(snapshot.groups)) !== input.expectedRevision) { throw new Error('Groups changed. Read groups.list again.'); } };
            const result = operation === 'create' ? await store.ensureGroup(input.name as string, input.section as 'main', undefined, check)
                : operation === 'rename' ? await store.renameGroup(input.id as string, input.name as string, check) : await store.deleteGroup(input.id as string, check);
            await refresh(); return result;
        });
    }
    add('groups.reorder', 'groups', 'Move a group in personal display order. Supply the current groupOrder[section] from groups.list.', {
        id: text, beforeId: text, section: choice('main', 'process', 'standalone'), expectedIds: array(text)
    }, ['id', 'section', 'expectedIds'], async input => {
        const env = projectLibraryEnvironment(); const snapshot = await createProjectLibraryStore(workspace.root, env.workspaceRoots, env.scanRoots).readMetadata();
        await new ProjectGroupDisplayOrder(context.workspaceState).move(workspace.root, input.section as 'main', snapshot.groups, input.id as string, input.beforeId as string | undefined, input.expectedIds as string[]);
        await refresh(); return { saved: true };
    });
    add('library.list', 'library', 'Read library item IDs, source locations, process steps and favorites. Filter and paginate.', { source: text, query: text, offset: integer, limit: { type: 'integer', minimum: 1, maximum: 200 } }, [], async input => {
        const snapshot = await deps.snapshots.ensureReady(input.source ? await source(input) : undefined);
        const items = snapshot.items.filter(item => !input.query || item.searchText.includes(String(input.query).toLowerCase()));
        const offset = input.offset as number ?? 0; const limit = input.limit as number ?? 50;
        return { identity: snapshot.viewIdentity, total: items.length, nextOffset: offset + limit < items.length ? offset + limit : undefined,
            items: items.slice(offset, offset + limit).map(item => ({ id: item.id, template: item.template, kind: item.kind, location: item.capturedLocation,
                processUri: item.processUri, processUid: item.processUid, processSteps: item.processSteps, stepsSignature: item.processStepsSignature, favorite: deps.favorites.isFavorite(item) })) };
    }, false);
    const item = async (input: Input, accessSource = true) => {
        const snapshot = await deps.snapshots.ensureReady(input.source ? await source(input) : undefined);
        const found = snapshot.items.find(item => item.id === input.itemId);
        if (!found) { throw new Error('Library item changed. Read library.list.'); }
        const location = found.capturedLocation?.uri ?? found.featureId ?? found.processUri;
        if (accessSource && location) { const uri = vscode.Uri.parse(location, true); if (uri.scheme !== 'file') { throw new Error('Choose a local allowed source.'); } await workspace.resolve(uri.fsPath); }
        return found;
    };
    add('scenario.delete', 'scenario', 'Delete a definition through native dependency, identity and attachment checks.', { itemId: text, source: text }, ['itemId'], async input => ({ deleted: await deps.library.delete(await item(input), input.source ? await source(input) : undefined) }), true, false, true);
    add('scenario.favorite', 'scenario', 'Toggle a library/scenario favorite through the shared favorites service.', { itemId: text, source: text }, ['itemId'], async input => ({ favorite: await deps.favorites.toggle(await item(input, false)) }));
    add('library.rename', 'library', 'Rename a user step, exported/nested scenario or main test through the native dependency-aware refactoring.', { itemId: text, source: text }, ['itemId'], async input => ({ renamed: await deps.library.rename(await item(input), input.source ? await source(input) : undefined) }));
    add('groups.rename_native', 'groups', 'Rename the group of a current main scenario/process using native format-specific checks, including legacy projects.', { itemId: text, source: text }, ['itemId'], async input => ({ renamed: await deps.library.renameMainGroup(await item(input)) }));
    for (const operation of ['move', 'reorder', 'remove', 'add'] as const) {
        add('process.' + operation, 'process', 'Change process steps through the shared library action service. Use the current stepsSignature from library.list; source identity, dirty state and signature are checked again before saving.', {
            itemId: text, source: text, expectedSignature: text, stepUid: text, direction: choice('up', 'down'), beforeStepUid: { anyOf: [text, { type: 'null' }] }
        }, ['itemId', 'expectedSignature', ...(operation === 'add' ? [] : ['stepUid']), ...(operation === 'move' ? ['direction'] : operation === 'reorder' ? ['beforeStepUid'] : [])], async input => {
            const target = await item(input);
            if (!target.processUri || !target.processUid || target.processStepsSignature !== input.expectedSignature) { throw new Error('The process changed. Read library.list again.'); }
            await source({ source: vscode.Uri.parse(target.processUri, true).fsPath });
            const request = { processUri: target.processUri, processUid: target.processUid, stepsSignature: input.expectedSignature as string, stepUid: input.stepUid as string };
            const changed = operation === 'add' ? await deps.library.addProcessSteps(target, request)
                : operation === 'move' ? await deps.library.moveProcessStep(target, { ...request, direction: input.direction as 'up' | 'down' })
                    : operation === 'reorder' ? await deps.library.reorderProcessStep(target, { ...request, beforeStepUid: input.beforeStepUid as string | null }) : await deps.library.removeProcessStep(target, request);
            await refresh(); return { changed };
        });
    }
    const attachmentFields = { itemId: text, source: text, resource: choice('source', 'compiled') };
    const attachmentItem = async (input: Input) => {
        const target = scenarioFilesItemForResource(await item(input), input.resource as 'source' | 'compiled' ?? 'source');
        if (!target || !scenarioFilesAvailable(target)) { throw new Error('Attachments require a SPPR scenario/process source, or its compiled resource after building. Standalone features do not provide this KOT attachment container.'); }
        if (input.resource === 'compiled' && !target.compiledFeatureUri) { throw new Error('Build the selected SPPR test before selecting its compiled files.'); }
        if (target.scenarioFilesRootUri) { await workspace.resolve(vscode.Uri.parse(target.scenarioFilesRootUri, true).fsPath, true); }
        return target;
    };
    add('attachments.list', 'attachments', 'List SPPR source attachments; resource:compiled selects the existing compiled container. Standalone features do not provide this container.', attachmentFields, ['itemId'], async input => {
        const target = await attachmentItem(input); const directories = ['']; const paths: string[] = []; let entries = 0;
        while (directories.length) {
            for (const node of await deps.files.listChildren(target, directories.pop()!)) {
                if (++entries > 10000) { throw new Error('Attachment inventory exceeds 10000 entries.'); }
                if (node.kind === 'directory') { directories.push(node.relativePath); } else { paths.push(node.relativePath); }
            }
        }
        return { paths: paths.sort() };
    }, false);
    for (const operation of ['open', 'rename', 'delete'] as const) {
        add('attachments.' + operation, 'attachments', 'Operate on a SPPR source attachment through its native safe file service. resource:compiled selects compiled files. Open supports the configured MXL viewer.', { ...attachmentFields, relativePath: text }, ['itemId', 'relativePath'], async input => {
            const target = await attachmentItem(input); const relative = input.relativePath as string;
            return operation === 'open' ? deps.files.openExternal(target, relative) : operation === 'rename' ? deps.files.renameFile(target, relative) : deps.files.deleteFile(target, relative);
        }, operation !== 'open', operation === 'open', operation === 'delete');
    }
    add('attachments.import', 'attachments', 'Import a local allowed file into the SPPR source container using the existing chunked transfer and collision handling. resource:compiled explicitly selects compiled files.', { ...attachmentFields, path: text, name: text }, ['itemId', 'path'], async input => {
        const target = await attachmentItem(input); const file = await workspace.resolve(input.path as string); const stat = await fs.stat(file);
        if (!stat.isFile()) { throw new Error('Choose an attachment file.'); }
        const name = input.name as string ?? path.basename(file);
        const plan = await deps.files.prepareDrop(target, '', [{ clientPath: name, kind: 'file', size: stat.size }]);
        for (const entry of plan.files) {
            const handle = await fs.open(file, 'r'); let offset = 0;
            try {
                const buffer = Buffer.alloc(128 * 1024);
                for (;;) { const read = await handle.read(buffer, 0, buffer.length, offset); if (!read.bytesRead) { break; }
                    offset = await deps.files.appendTransferChunk(entry.transferId, offset, buffer.subarray(0, read.bytesRead).toString('base64')); }
                const current = await handle.stat();
                if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || offset !== stat.size) { throw new Error('The attachment changed during import. Retry from the saved source.'); }
                await deps.files.completeTransfer(entry.transferId);
            } catch (error) { await deps.files.cancelTransfer(entry.transferId); throw error; } finally { await handle.close(); }
        }
        return { imported: plan.files.map(entry => entry.destinationRelativePath), skipped: plan.skipped };
    });
    return {
        list: () => [...actions.values()].map(action => action.descriptor),
        invoke: async (id, input) => {
            const action = actions.get(id); if (!action) { throw new Error('Unknown KOT action.'); }
            return action.run(input);
        },
        resolvePath: async (file, create) => {
            let resolved: string | undefined;
            if (selectedBaseRoot) {
                try { resolved = await new AgentWorkspace(workspace.root, () => [selectedBaseRoot!]).resolve(file, create); }
                catch { /* Other paths still need the configured roots or native access approval. */ }
            }
            resolved ??= await workspace.resolve(file, create);
            return vscode.Uri.file(resolved);
        },
        token: signal => { const source = new vscode.CancellationTokenSource(); signal.addEventListener('abort', () => source.cancel(), { once: true }); return source.token; }
    };
}
