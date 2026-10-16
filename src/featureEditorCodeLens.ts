import * as vscode from 'vscode';
import { getScenarioLanguageForDocument } from './gherkinLanguage';
import { getTranslator, type Translator } from './localization';
import {
    buildFeatureEditorActions, FEATURE_EDITOR_COMMAND, getFeatureStepTagAction, isFeatureEditorTarget,
    planFeatureEditorEdit, featureScenarioTitle,
    type FeatureEditorEditOptions, type FeatureEditorSource, type FeatureStepTag, type FeatureVariableKind
} from './featureEditorActions';
import { normalizeFeatureTags } from './featureTags';
import { parseStandaloneFeatureSource } from './standaloneFeatureModel';
import { buildGherkinAnnotationCompletions, getGherkinStepAnnotationTarget, isGherkinHeaderAnnotationContext } from './gherkinAnnotations';

export interface ProjectAnnotationTags {
    getTags(resource: vscode.Uri, token: vscode.CancellationToken): Promise<readonly string[]>;
}

function sourceFor(document: vscode.TextDocument): FeatureEditorSource {
    const text = document.getText();
    const uri = document.uri.toString();
    return { text, uri, version: document.version, language: /\.feature(?:[?#]|$)/iu.test(uri)
        ? parseStandaloneFeatureSource(text, '').language : getScenarioLanguageForDocument(document) };
}

function stepTags(translate: Translator): { label: string; tag: FeatureStepTag; description: string }[] {
    return [
        { label: '@screenshot', tag: 'screenshot', description: translate('Screenshots before and after the step; enable screenshots in Vanessa.') },
        { label: '@recordvideo', tag: 'recordvideo', description: translate('Record from this step to the end; requires ffmpeg.') },
        { label: '@StopRecordVideo', tag: 'StopRecordVideo', description: translate('Stop a video fragment.') },
        { label: '@StartRecordVideo', tag: 'StartRecordVideo', description: translate('Start a video fragment.') }
    ];
}

export class FeatureStepTagCompletionProvider implements vscode.CompletionItemProvider {
    private readonly translator: Promise<Translator>;
    constructor(extensionUri: vscode.Uri, private readonly projectTags?: ProjectAnnotationTags) { this.translator = getTranslator(extensionUri); }
    async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<vscode.CompletionItem[]> {
        const source = sourceFor(document);
        const t = await this.translator;
        if (token.isCancellationRequested || document.version !== source.version) { return []; }
        const invoked = context.triggerKind === vscode.CompletionTriggerKind.Invoke;
        let tags: readonly string[] = [];
        if (this.projectTags && isGherkinHeaderAnnotationContext(source, position.line, position.character, invoked)) {
            tags = await this.projectTags.getTags(document.uri, token);
            if (token.isCancellationRequested || document.version !== source.version) { return []; }
        }
        const completions = buildGherkinAnnotationCompletions(source, position.line, position.character, invoked, tags, t);
        return completions.map((completion, index) => {
            const item = new vscode.CompletionItem(completion.label, vscode.CompletionItemKind.Keyword);
            item.range = new vscode.Range(document.positionAt(completion.start), document.positionAt(completion.end));
            item.insertText = completion.snippet ? new vscode.SnippetString(completion.insertText) : completion.insertText;
            item.filterText = completion.filterText;
            item.sortText = `0_featureAnnotation_${String(index).padStart(3, '0')}`;
            item.keepWhitespace = true;
            item.documentation = completion.documentation;
            return item;
        });
    }
}

export class FeatureEditorCodeLensProvider implements vscode.CodeLensProvider {
    private readonly translator: Promise<Translator>;
    constructor(extensionUri: vscode.Uri) { this.translator = getTranslator(extensionUri); }
    async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        const t = await this.translator;
        if (token.isCancellationRequested) { return []; }
        const actions = buildFeatureEditorActions(sourceFor(document), t);
        const properties = actions.length ? [new vscode.CodeLens(new vscode.Range(actions[0].line, 0, actions[0].line, 0),
            { title: t('Edit scenario and properties'), command: 'kotTestToolkit.openScenarioEditor', arguments: [document.uri] })] : [];
        return [...properties, ...actions.map(action => new vscode.CodeLens(
            new vscode.Range(action.line, 0, action.line, 0),
            { title: action.title, command: FEATURE_EDITOR_COMMAND, arguments: [action.target] }
        ))];
    }
}

/** Native inline quick actions are also available on the selected step through the lightbulb. */
export class FeatureStepTagCodeActionProvider implements vscode.CodeActionProvider {
    static readonly providedCodeActionKinds = [vscode.CodeActionKind.RefactorRewrite];
    provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
        const source = sourceFor(document);
        const action = getFeatureStepTagAction(source, range.start.line);
        if (!action) { return []; }
        return getGherkinStepAnnotationTarget(source, range.start.line)!.tags.map(stepTag => {
            const item = new vscode.CodeAction(`+ @${stepTag}`, vscode.CodeActionKind.RefactorRewrite);
            item.command = { title: item.title, command: FEATURE_EDITOR_COMMAND, arguments: [action.target, { stepLine: range.start.line, stepTag }] };
            return item;
        });
    }
}

export async function editFeatureStructureCommand(rawTarget: unknown, translate: Translator, directOptions?: FeatureEditorEditOptions): Promise<void> {
    if (!isFeatureEditorTarget(rawTarget)) { return; }
    const uri = vscode.Uri.parse(rawTarget.uri);
    if (uri.scheme !== 'file') { return; }
    try {
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.version !== rawTarget.version) { throw new Error('The feature changed. Run the action again.'); }
        const source = sourceFor(document);
        if (rawTarget.kind === 'stepTag') {
            const action = getFeatureStepTagAction(source, directOptions?.stepLine ?? -1);
            if (!action || action.target.line !== rawTarget.line) { return; }
        } else if (!buildFeatureEditorActions(source).some(action => action.kind === rawTarget.kind && action.line === rawTarget.line)) { return; }
        let options: FeatureEditorEditOptions = {};
        if (rawTarget.kind === 'scenario') {
            const forms: { label: string; scenarioKind: 'scenario' | 'outline' }[] = [
                { label: source.language === 'ru' ? 'Сценарий' : 'Scenario', scenarioKind: 'scenario' },
                { label: source.language === 'ru' ? 'Структура сценария' : 'Scenario Outline', scenarioKind: 'outline' }
            ];
            const chosen = directOptions?.scenarioKind ? forms.find(form => form.scenarioKind === directOptions.scenarioKind)
                : await vscode.window.showQuickPick(forms, { title: translate('Add scenario'), ignoreFocusOut: true });
            if (!chosen) { return; }
            const name = directOptions?.scenarioTitle ?? await vscode.window.showInputBox({ title: translate('New scenario'),
                prompt: translate('Scenario title'), ignoreFocusOut: true, validateInput: value => {
                    try { featureScenarioTitle(value); return undefined; } catch (error) { return translate((error as Error).message); }
                } });
            if (name === undefined) { return; }
            options = { scenarioKind: chosen.scenarioKind, scenarioTitle: name };
        } else if (rawTarget.kind === 'tags') {
            const tags = await vscode.window.showInputBox({
                title: translate('Feature / scenario tags'), prompt: translate('Enter tags separated by spaces, for example @Smoke @team.sales.'),
                ignoreFocusOut: true, validateInput: value => {
                    try { normalizeFeatureTags(value.trim().split(/[ \t]+/u)); return undefined; }
                    catch { return translate('Enter valid tags on one line, separated by spaces.'); }
                }
            });
            if (tags === undefined) { return; }
            options = { tags };
        } else if (rawTarget.kind === 'variable') {
            const forms: { label: string; variableKind: FeatureVariableKind; description?: string }[] = [
                { label: translate('Simple variable'), variableKind: 'simple' },
                { label: translate('Computed variable'), variableKind: 'computed', description: '{expression}' },
                { label: translate('Server computed variable'), variableKind: 'server', description: '{!expression}' },
                { label: translate('Multiline variable'), variableKind: 'multiline' },
                { label: translate('Variables table'), variableKind: 'table' },
                { label: translate('Import variables from feature'), variableKind: 'import' }
            ];
            const chosen = await vscode.window.showQuickPick(forms, { title: translate('Add Vanessa variable'), ignoreFocusOut: true });
            if (!chosen) { return; }
            options = { variableKind: chosen.variableKind };
        } else if (rawTarget.kind === 'stepTag') {
            options = { stepLine: directOptions!.stepLine, stepTag: directOptions?.stepTag };
            if (!options.stepTag) {
                const chosenTag = await vscode.window.showQuickPick(stepTags(translate), { title: translate('Step screenshot / video'), ignoreFocusOut: true });
                if (!chosenTag) { return; }
                options = { ...options, stepTag: chosenTag.tag };
            }
        }
        if (document.version !== rawTarget.version) { throw new Error('The feature changed. Run the action again.'); }
        const edit = planFeatureEditorEdit(source, rawTarget, options);
        if (!edit) { return; }
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        if (document.version !== rawTarget.version) { throw new Error('The feature changed. Run the action again.'); }
        const applied = await editor.insertSnippet(new vscode.SnippetString(edit.snippet), new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), { keepWhitespace: true, undoStopBefore: true, undoStopAfter: true });
        if (!applied) { vscode.window.showErrorMessage(translate('Could not update the feature.')); }
    } catch (error) {
        vscode.window.showErrorMessage(translate('Could not update the feature: {0}', translate(error instanceof Error ? error.message : String(error))));
    }
}

export { FEATURE_EDITOR_COMMAND };
