import * as vscode from 'vscode';
import type {
    ProjectDefinition,
    ProjectDefinitionLocation,
    ProjectDefinitionMatch
} from './projectDefinition';
import type { ProjectDefinitionResolver } from './projectDefinitionResolver';

function navigableLocation(definition: ProjectDefinition): ProjectDefinitionLocation | undefined {
    return definition.implementationLocation ?? definition.definitionLocation;
}

function toRange(location: ProjectDefinitionLocation): vscode.Range {
    return new vscode.Range(
        new vscode.Position(location.range.start.line, location.range.start.character),
        new vscode.Position(location.range.end.line, location.range.end.character)
    );
}

function toLocationLink(match: ProjectDefinitionMatch, line: number): vscode.LocationLink | null {
    const location = navigableLocation(match.definition);
    if (!location) {
        return null;
    }
    const targetRange = toRange(location);
    return {
        originSelectionRange: new vscode.Range(
            line,
            match.invocationRange.start,
            line,
            match.invocationRange.end
        ),
        targetUri: vscode.Uri.parse(location.uri),
        targetRange,
        targetSelectionRange: targetRange
    };
}

async function openLocation(location: ProjectDefinitionLocation): Promise<boolean> {
    try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(location.uri));
        const editor = await vscode.window.showTextDocument(document, {
            preview: false,
            preserveFocus: false
        });
        const range = toRange(location);
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to open definition: {0}', message));
        return false;
    }
}

export class ProjectDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private readonly resolver: ProjectDefinitionResolver) {}

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.LocationLink[]> {
        if (token.isCancellationRequested) {
            return [];
        }
        const invocation = document.lineAt(position.line).text;
        const resolution = await this.resolver.resolve(document.uri, invocation);
        if (token.isCancellationRequested || resolution.kind === 'missing') {
            return [];
        }

        const matches = resolution.kind === 'unique' ? [resolution.match] : resolution.matches;
        return matches
            .map(match => toLocationLink(match, position.line))
            .filter((link): link is vscode.LocationLink => link !== null);
    }
}

export async function openProjectDefinitionHandler(
    definitionId: string,
    resourceUri: vscode.Uri | string | undefined,
    resolver: ProjectDefinitionResolver
): Promise<boolean> {
    const resource = typeof resourceUri === 'string'
        ? vscode.Uri.parse(resourceUri)
        : resourceUri;
    const definition = (await resolver.getView(resource)).byId.get(definitionId);
    if (!definition) {
        vscode.window.showInformationMessage(vscode.l10n.t('Project definition is no longer available.'));
        return false;
    }
    const location = navigableLocation(definition);
    if (!location) {
        vscode.window.showInformationMessage(vscode.l10n.t('This definition has no project source location.'));
        return false;
    }
    return openLocation(location);
}

export async function pickProjectDefinition(
    definitions: readonly ProjectDefinition[],
    resourceUri: vscode.Uri | string | undefined,
    resolver: ProjectDefinitionResolver,
    title = vscode.l10n.t('Choose project definition')
): Promise<boolean> {
    if (definitions.length === 0) {
        return false;
    }
    if (definitions.length === 1) {
        return openProjectDefinitionHandler(definitions[0].id, resourceUri, resolver);
    }

    const picked = await vscode.window.showQuickPick(
        definitions.map(definition => ({
            label: definition.template,
            description: definition.sourceLabel,
            detail: navigableLocation(definition)?.uri,
            definitionId: definition.id
        })),
        { title, ignoreFocusOut: true }
    );
    if (!picked) {
        return false;
    }
    return openProjectDefinitionHandler(picked.definitionId, resourceUri, resolver);
}
