import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestInfo } from './types';
import type { Translator } from './localization';
import { convertSpprScenarioFiles } from './spprScenarioFormat';
import { waitForProjectLibraryIdle } from './projectLibraryStore';

interface BatchOptions {
    documents?: () => readonly Pick<vscode.TextDocument, 'uri' | 'isDirty'>[];
    cancelled?: () => boolean;
    progress?: (completed: number, total: number, scenario: TestInfo) => void;
}

export interface ScenarioBatchConversionResult {
    converted: Array<{ scenario: TestInfo; metadataPath: string }>;
    failed: Array<{ scenario: TestInfo; error: string }>;
    remaining: number;
    cancelled: boolean;
}

function fileKey(file: string): string {
    const resolved = path.resolve(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function legacyScenarioCandidates(scenarios: readonly TestInfo[]): TestInfo[] {
    const candidates = new Map<string, TestInfo>();
    for (const scenario of scenarios) {
        if (scenario.kind !== 'process' && scenario.yamlFileUri.scheme === 'file'
            && path.basename(scenario.yamlFileUri.fsPath) === 'scen.yaml') {
            candidates.set(fileKey(scenario.yamlFileUri.fsPath), scenario);
        }
    }
    return [...candidates.values()].sort((a, b) => a.name.localeCompare(b.name) || a.relativePath.localeCompare(b.relativePath));
}

/** Each scenario is atomic; cancellation never interrupts a file transaction. */
export async function convertLegacyScenarios(scenarios: readonly TestInfo[], options: BatchOptions = {}): Promise<ScenarioBatchConversionResult> {
    const result: ScenarioBatchConversionResult = { converted: [], failed: [], remaining: scenarios.length, cancelled: false };
    for (const scenario of scenarios) {
        if (options.cancelled?.()) { result.cancelled = true; break; }
        try {
            const directory = path.dirname(scenario.yamlFileUri.fsPath);
            const affected = new Set(['scen.yaml', 'meta.yaml', 'scen.feature', 'scen.yaml.kot.yml', 'meta.yaml.kot.yml']
                .map(file => fileKey(path.join(directory, file))));
            const assertSaved = () => {
                if ((options.documents?.() ?? []).some(document => document.isDirty && document.uri.scheme === 'file'
                    && affected.has(fileKey(document.uri.fsPath)))) {
                    throw new Error('Save the SPPR scenario, script and metadata before converting its format.');
                }
            };
            await waitForProjectLibraryIdle();
            const metadataPath = await convertSpprScenarioFiles(scenario.yamlFileUri.fsPath, 'native', assertSaved);
            result.converted.push({ scenario, metadataPath });
        } catch (error) {
            result.failed.push({ scenario, error: error instanceof Error ? error.message : String(error) });
        }
        result.remaining--;
        options.progress?.(scenarios.length - result.remaining, scenarios.length, scenario);
    }
    return result;
}

function markdownText(text: string): string {
    return text.replace(/\r?\n/gu, ' ').replace(/[\\`*_[\]<>]/gu, '\\$&');
}

function conversionReport(result: ScenarioBatchConversionResult, t: Translator, notes: readonly string[]): string {
    const lines = [
        `# ${t('YAML to feature + meta conversion')}`, '',
        t('Converted: {0}. Not converted: {1}. Not processed: {2}.', String(result.converted.length), String(result.failed.length), String(result.remaining)), ''
    ];
    if (result.cancelled) { lines.push(t('Cancelled. Completed conversions have been kept; remaining scenarios have not been changed.'), ''); }
    if (result.converted.length) {
        lines.push(`## ${t('Converted scenarios')}`, '');
        for (const { scenario, metadataPath } of result.converted) {
            const script = vscode.Uri.file(path.join(path.dirname(metadataPath), 'scen.feature')).toString();
            lines.push(`- [${markdownText(scenario.name)}](<${script}>) — ${markdownText(scenario.relativePath)}`);
        }
        lines.push('');
    }
    if (result.failed.length) {
        lines.push(`## ${t('Scenarios not converted')}`, '');
        for (const { scenario, error } of result.failed) {
            lines.push(`- **${markdownText(scenario.name)}** (${markdownText(scenario.relativePath)}): ${markdownText(t(error))}`);
        }
        lines.push('');
    }
    for (const note of notes) { lines.push(markdownText(note), ''); }
    return lines.join('\n');
}

let batchInProgress = false;

export async function handleBatchScenarioFormatConversion(
    getScenarios: () => Promise<readonly TestInfo[]>, t: Translator
): Promise<ScenarioBatchConversionResult | undefined> {
    if (batchInProgress) {
        void vscode.window.showInformationMessage(t('Scenario format conversion is already running.'));
        return;
    }
    batchInProgress = true;
    try {
        const activeSource = vscode.window.activeTextEditor?.document.uri.toString();
        const candidates = legacyScenarioCandidates(await getScenarios());
        if (!candidates.length) {
            void vscode.window.showInformationMessage(t('No YAML scenarios to convert were found in the project scenario catalog.'));
            return;
        }
        const selected = await vscode.window.showQuickPick(candidates.map(scenario => ({
            label: scenario.name,
            description: vscode.workspace.asRelativePath(scenario.yamlFileUri),
            detail: scenario.hasTestSettings ? t('Main scenario') : t('Nested scenario'),
            picked: true, scenario
        })), {
            title: t('Convert YAML scenarios to feature + meta'),
            placeHolder: t('Select scenarios to convert. Existing destination files will not be overwritten.'),
            canPickMany: true, ignoreFocusOut: true
        });
        if (!selected?.length) { return; }
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t('Converting YAML scenarios to feature + meta'), cancellable: true
        }, (progress, token) => convertLegacyScenarios(selected.map(item => item.scenario), {
            documents: () => vscode.workspace.textDocuments,
            cancelled: () => token.isCancellationRequested,
            progress: (completed, total, scenario) => progress.report({
                increment: 100 / total,
                message: t('Processed {0}/{1}: {2}', String(completed), String(total), scenario.name)
            })
        }));
        const notes: string[] = [];
        if (result.converted.length) {
            try {
                await vscode.commands.executeCommand('kotTestToolkit.refreshPhaseSwitcher', {
                    refreshCache: true,
                    changedSourceUris: result.converted.flatMap(({ metadataPath }) => ['scen.yaml', 'meta.yaml', 'scen.feature']
                        .map(file => vscode.Uri.file(path.join(path.dirname(metadataPath), file)).toString()))
                });
            } catch (error) {
                notes.push(t('Files were converted, but the project views could not be refreshed: {0}', error instanceof Error ? error.message : String(error)));
            }
            const active = result.converted.find(({ scenario }) => scenario.yamlFileUri.toString() === activeSource);
            if (active) {
                try {
                    const script = vscode.Uri.file(path.join(path.dirname(active.metadataPath), 'scen.feature'));
                    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(script), { preview: false });
                } catch (error) {
                    notes.push(t('Files were converted, but the active script could not be opened: {0}', error instanceof Error ? error.message : String(error)));
                }
            }
        }
        const report = await vscode.workspace.openTextDocument({ language: 'markdown', content: conversionReport(result, t, notes) });
        await vscode.window.showTextDocument(report, { preview: false });
        return result;
    } catch (error) {
        void vscode.window.showErrorMessage(t('Could not complete batch scenario conversion: {0}', error instanceof Error ? error.message : String(error)));
        return;
    } finally {
        batchInProgress = false;
    }
}
