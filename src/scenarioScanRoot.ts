import * as path from 'path';
import * as vscode from 'vscode';

const SCENARIO_SCAN_ROOT_KEY = 'kotTestToolkit.scenarioScanRoot';
const DEFAULT_SCENARIO_SCAN_ROOT = 'tests/RegressionTests/yaml';

let currentScenarioScanRoot = DEFAULT_SCENARIO_SCAN_ROOT;

const scanRootDidChangeEmitter = new vscode.EventEmitter<string>();

export const onDidChangeScenarioScanRoot = scanRootDidChangeEmitter.event;

export function initializeScenarioScanRoot(context: vscode.ExtensionContext): string {
    const storedValue = String(context.workspaceState.get<string>(SCENARIO_SCAN_ROOT_KEY, '') || '').trim();
    if (storedValue) {
        currentScenarioScanRoot = storedValue;
        return currentScenarioScanRoot;
    }

    const legacySettingValue = String(
        vscode.workspace.getConfiguration('kotTestToolkit').get<string>('paths.yamlSourceDirectory') || ''
    ).trim();
    currentScenarioScanRoot = legacySettingValue || DEFAULT_SCENARIO_SCAN_ROOT;

    if (currentScenarioScanRoot) {
        void context.workspaceState.update(SCENARIO_SCAN_ROOT_KEY, currentScenarioScanRoot);
    }

    return currentScenarioScanRoot;
}

export function getScenarioScanRootPath(): string {
    return currentScenarioScanRoot || DEFAULT_SCENARIO_SCAN_ROOT;
}

export function resolveScenarioScanRootFsPath(workspaceRootUri: vscode.Uri): string {
    const configuredPath = getScenarioScanRootPath().trim() || DEFAULT_SCENARIO_SCAN_ROOT;
    return path.isAbsolute(configuredPath)
        ? configuredPath
        : path.join(workspaceRootUri.fsPath, configuredPath);
}

export async function updateScenarioScanRoot(
    context: vscode.ExtensionContext,
    nextPath: string
): Promise<boolean> {
    const normalizedPath = String(nextPath || '').trim() || DEFAULT_SCENARIO_SCAN_ROOT;
    if (normalizedPath === currentScenarioScanRoot) {
        return false;
    }

    currentScenarioScanRoot = normalizedPath;
    await context.workspaceState.update(SCENARIO_SCAN_ROOT_KEY, currentScenarioScanRoot);
    scanRootDidChangeEmitter.fire(currentScenarioScanRoot);
    return true;
}
