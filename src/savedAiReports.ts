import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { getFormExplorerConfigurationSourceDirectory } from './formExplorerPaths';
import { getScenarioScanRootPath } from './scenarioScanRoot';

const execute = promisify(execFile);

// Preserve the original branch filenames so reports from the direct LLM mode remain readable.
function reportFileName(branch: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < branch.length; index++) {
        hash ^= branch.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    const name = branch.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'branch';
    return `${name}--${(hash >>> 0).toString(16).padStart(8, '0')}.md`;
}

async function savedReportUri(kind: 'configuration-diff' | 'test-review'): Promise<vscode.Uri | undefined> {
    try {
        let directory: string;
        if (kind === 'configuration-diff') {
            directory = getFormExplorerConfigurationSourceDirectory() || '';
            if (!directory || !(await fs.stat(directory)).isDirectory()) { return undefined; }
        } else {
            directory = String(getScenarioScanRootPath() || '').trim();
            if (!path.isAbsolute(directory)) {
                const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!folder) { return undefined; }
                directory = path.join(folder, directory || 'tests/RegressionTests/yaml');
            }
        }
        const { stdout } = await execute('git', ['rev-parse', '--show-toplevel'], { cwd: directory, maxBuffer: 1024 * 1024 });
        const root = stdout.trim();
        const relative = path.relative(root, directory);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) { return undefined; }
        let branch = 'HEAD';
        try {
            const result = await execute('git', ['branch', '--show-current'], { cwd: root, maxBuffer: 1024 * 1024 });
            branch = result.stdout.trim() || 'HEAD';
        } catch { /* The old mode also used HEAD when branch discovery failed. */ }
        const anchor = vscode.Uri.file(root);
        const scope = vscode.workspace.getWorkspaceFolder(anchor)?.uri ?? anchor;
        const runtime = (vscode.workspace.getConfiguration('kotTestToolkit', scope).get<string>('runtime.directory') || '').trim();
        const runtimeUri = runtime && path.isAbsolute(runtime) ? vscode.Uri.file(runtime) : vscode.Uri.joinPath(scope, runtime || '.vscode/kot-runtime');
        const uri = vscode.Uri.joinPath(runtimeUri, `${kind}-ai-reports`, reportFileName(branch));
        await vscode.workspace.fs.stat(uri);
        return uri;
    } catch { return undefined; }
}

async function openSavedReport(kind: 'configuration-diff' | 'test-review'): Promise<boolean> {
    const uri = await savedReportUri(kind);
    if (!uri) { return false; }
    await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
    return true;
}

export const openSavedConfigurationDiffImpactReport = (): Promise<boolean> => openSavedReport('configuration-diff');
export const openSavedTestReviewReport = (): Promise<boolean> => openSavedReport('test-review');
