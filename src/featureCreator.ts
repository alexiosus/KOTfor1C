import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getTranslator } from './localization';
import { getConfiguredScenarioLanguage, type ScenarioLanguage } from './gherkinLanguage';
import { resolveScenarioScanRootFsPath } from './scenarioScanRoot';
import { renderFeatureTemplate, validateFeatureTitle } from './featureTemplate';
import { buildStandaloneFeatureLaunchJson, parseStandaloneFeatureLaunchJson } from './standaloneFeatureLaunch';
import { YamlParametersManager } from './yamlParametersManager';

export interface CreateFeatureOptions {
    readonly destinationUri?: vscode.Uri;
    readonly featureTitle?: string;
    readonly scenarioTitle?: string;
    readonly language?: ScenarioLanguage;
    readonly tags?: readonly string[];
}

function withinRoot(candidate: string, root: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function validateDestinationDirectory(directory: string, root: string): Promise<void> {
    if (!withinRoot(directory, root)) {
        throw new Error('Feature destination must be inside the configured tests directory.');
    }
    await fs.mkdir(root, { recursive: true });
    const physicalRoot = await fs.realpath(root);
    let ancestor = directory;
    for (;;) {
        try {
            if (!withinRoot(await fs.realpath(ancestor), physicalRoot)) {
                throw new Error('Feature destination must be inside the configured tests directory.');
            }
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
            ancestor = path.dirname(ancestor);
        }
    }
    await fs.mkdir(directory, { recursive: true });
    if (!withinRoot(await fs.realpath(directory), physicalRoot)) {
        throw new Error('Feature destination must be inside the configured tests directory.');
    }
}

function safeFeatureFilename(title: string): string {
    const stem = title.trim().replace(/[\\/:*?"<>|\u0000-\u001F]/gu, '-').replace(/^[. ]+|[. ]+$/gu, '').slice(0, 120) || 'new-feature';
    return `${/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem) ? `feature-${stem}` : stem}.feature`;
}

/** Creates a feature under the shared tests root; an existing feature is never replaced. */
export async function createFeature(context: vscode.ExtensionContext, options: CreateFeatureOptions = {}): Promise<vscode.Uri | undefined> {
    const t = await getTranslator(context.extensionUri);
    try {
        const workspace = vscode.workspace.workspaceFolders?.[0];
        if (!workspace || workspace.uri.scheme !== 'file') {
            throw new Error(t('Open a local workspace to create a feature.'));
        }
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const language = options.language ?? getConfiguredScenarioLanguage(config);
        const featureTitle = options.featureTitle ?? await vscode.window.showInputBox({
            title: t('New feature'), prompt: t('Feature title'), ignoreFocusOut: true,
            validateInput: value => { const error = validateFeatureTitle(value); return error ? t(error) : undefined; }
        });
        if (featureTitle === undefined) { return undefined; }
        const scenarioTitle = options.scenarioTitle ?? await vscode.window.showInputBox({
            title: t('New feature'), prompt: t('First scenario title'), value: featureTitle.trim(), ignoreFocusOut: true,
            validateInput: value => { const error = validateFeatureTitle(value); return error ? t(error) : undefined; }
        });
        if (scenarioTitle === undefined) { return undefined; }
        let tags = options.tags;
        if (!tags) {
            const choice = await vscode.window.showQuickPick([
                { label: t('Standard feature'), tags: [] as string[] },
                { label: t('Draft feature (@Draft)'), description: t('Adds the draft tag.'), tags: ['Draft'] }
            ], { title: t('Feature tags'), ignoreFocusOut: true });
            if (!choice) { return undefined; }
            tags = choice.tags;
        }
        const templateSetting = config.get<string>('editor.newFeatureTemplatePath', '').trim();
        const templatePath = templateSetting.replace(/\$\{workspaceFolder\}/gu, workspace.uri.fsPath);
        const template = templateSetting
            ? await fs.readFile(path.isAbsolute(templatePath) ? templatePath : path.resolve(workspace.uri.fsPath, templatePath), 'utf8')
            : undefined;
        const text = renderFeatureTemplate({ featureTitle, scenarioTitle, language, template, tags });
        const root = resolveScenarioScanRootFsPath(workspace.uri);
        const target = options.destinationUri ?? await vscode.window.showSaveDialog({
            title: t('Save feature'), defaultUri: vscode.Uri.file(path.join(root, safeFeatureFilename(featureTitle))),
            filters: { [t('Vanessa feature files')]: ['feature'] }
        });
        if (!target) { return undefined; }
        if (target.scheme !== 'file') { throw new Error(t('Feature destination must be a local file.')); }
        const targetPath = path.extname(target.fsPath) ? target.fsPath : `${target.fsPath}.feature`;
        if (!/\.feature$/iu.test(targetPath)) { throw new Error(t('Feature filename must end with .feature.')); }
        await validateDestinationDirectory(path.dirname(targetPath), root);
        await fs.writeFile(targetPath, text, { encoding: 'utf8', flag: 'wx' });
        const createdUri = vscode.Uri.file(targetPath);
        const document = await vscode.workspace.openTextDocument(createdUri);
        await vscode.window.showTextDocument(document);
        return createdUri;
    } catch (error) {
        const message = (error as NodeJS.ErrnoException).code === 'EEXIST'
            ? t('Feature already exists. Choose another filename.')
            : error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(t('Could not create feature: {0}', message));
        return undefined;
    }
}

/** Generates same-stem VAParams from a selected saved profile without activating it. */
export async function generateFeatureJson(context: vscode.ExtensionContext, featureUri: vscode.Uri): Promise<vscode.Uri | undefined> {
    const t = await getTranslator(context.extensionUri);
    try {
        if (featureUri.scheme !== 'file' || !/\.feature$/iu.test(featureUri.fsPath) || !(await fs.stat(featureUri.fsPath)).isFile()) {
            throw new Error(t('Choose an existing local .feature file.'));
        }
        const manager = YamlParametersManager.getInstance(context);
        const summary = await manager.getProfilesSummary();
        const selected = await vscode.window.showQuickPick(summary.profiles.map(profile => ({
            ...profile, label: profile.name, description: profile.id === summary.activeProfileId ? t('Current') : undefined
        })), { title: t('Parameter profile for feature JSON'), ignoreFocusOut: true });
        if (!selected) { return undefined; }
        const profile = await manager.loadProfileSnapshot(selected.id);
        if (!profile) { throw new Error(t('The selected parameter profile no longer exists.')); }
        const outputPath = featureUri.fsPath.replace(/\.feature$/iu, '.json');
        let previousText: string | undefined;
        try {
            previousText = await fs.readFile(outputPath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        }
        if (previousText !== undefined) {
            const replace = t('Replace JSON');
            const confirmation = await vscode.window.showWarningMessage(t('Replace existing feature JSON at {0}? Custom settings will be retained.', outputPath), { modal: true }, replace);
            if (confirmation !== replace) { return undefined; }
        }
        const workspace = vscode.workspace.getWorkspaceFolder(featureUri) ?? vscode.workspace.workspaceFolders?.[0];
        const workspaceRootPath = workspace?.uri.fsPath ?? path.dirname(featureUri.fsPath);
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const json = buildStandaloneFeatureLaunchJson(profile, {
            featurePath: featureUri.fsPath, workspaceRootPath,
            runtimeDirectory: config.get<string>('runtime.directory', '.vscode/kot-runtime'),
            baseJson: previousText !== undefined ? parseStandaloneFeatureLaunchJson(previousText) : undefined
        });
        const text = `${JSON.stringify(json, null, 2)}\n`;
        if (previousText === undefined) {
            await fs.writeFile(outputPath, text, { encoding: 'utf8', flag: 'wx' });
        } else {
            if (await fs.readFile(outputPath, 'utf8') !== previousText) {
                throw new Error(t('Feature JSON changed while generating it. Run the command again.'));
            }
            await fs.writeFile(outputPath, text, 'utf8');
        }
        const result = vscode.Uri.file(outputPath);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(result));
        return result;
    } catch (error) {
        await vscode.window.showErrorMessage(t('Could not generate feature JSON: {0}', error instanceof Error ? error.message : String(error)));
        return undefined;
    }
}
