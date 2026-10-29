import * as vscode from 'vscode';

export interface VanessaFailureHoverItem {
    readonly scenarioName: string;
    readonly failureSummary?: string;
    readonly failureDetails?: string;
    readonly failureStepDescription?: string;
    readonly openLogUri?: string;
    readonly openNestedScenarioUri?: string;
}

/** Shared presentation for failures reported by the run log and by MCP. */
export function buildVanessaFailureHover(highlights: readonly VanessaFailureHoverItem[],
    t: (message: string, ...args: string[]) => string = vscode.l10n.t): vscode.MarkdownString | undefined {
    if (!highlights.length) { return undefined; }
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = { enabledCommands: ['vscode.open', 'kotTestToolkit.openRunScenarioLog', 'kotTestToolkit.openFailedNestedScenarioFromRun'] };
    highlights.slice(0, 3).forEach((highlight, index) => {
        if (index) { markdown.appendMarkdown('\n\n---\n\n'); }
        markdown.appendMarkdown('**'); markdown.appendText(t('Failed step in scenario "{0}"', highlight.scenarioName)); markdown.appendMarkdown('**\n\n');
        const actions = [
            highlight.openLogUri && `[${t('Open run log')}](${highlight.openLogUri})`,
            highlight.openNestedScenarioUri && `[${t('Open failed nested scenario')}](${highlight.openNestedScenarioUri})`
        ].filter(Boolean);
        if (actions.length) { markdown.appendMarkdown(actions.join(' • ') + '\n\n'); }
        const summary = highlight.failureSummary?.trim();
        if (summary) { markdown.appendCodeblock(summary, 'text'); }
        else { markdown.appendMarkdown(`_${t('No failure details available.')}_\n\n`); }
        const details = highlight.failureDetails?.trim();
        if (details) { markdown.appendMarkdown('\n'); markdown.appendCodeblock(details.length > 20_000 ? details.slice(0, 20_000) + '\n...' : details, 'text'); }
        const description = highlight.failureStepDescription?.trim();
        if (description) { markdown.appendMarkdown(`\n_${t('Step description')}_\n`); markdown.appendCodeblock(description, 'text'); }
    });
    if (highlights.length > 3) { markdown.appendMarkdown(`\n\n_${t('And {0} more failed scenario(s) on this line.', String(highlights.length - 3))}_`); }
    return markdown;
}
