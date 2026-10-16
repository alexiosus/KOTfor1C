import * as path from 'path';
import * as vscode from 'vscode';
import { findCompilerBuildParameter, type CompilerBuildParameter } from './compilerBuildParameters';
import { DEFAULT_SCENARIO_SOURCE_ROOT } from './yamlParameterDefaults';

const SCENARIO_SCAN_ROOT_KEY = 'kotTestToolkit.scenarioScanRoot';
const PROCESS_SCAN_ROOT_KEY = 'kotTestToolkit.processScanRoot';
const DEFAULT_SCENARIO_SCAN_ROOT = DEFAULT_SCENARIO_SOURCE_ROOT;

let currentScenarioScanRoot = DEFAULT_SCENARIO_SCAN_ROOT;
let currentProcessScanRoot = '';

const scanRootDidChangeEmitter = new vscode.EventEmitter<string>();

export const onDidChangeScenarioScanRoot = scanRootDidChangeEmitter.event;

export function initializeScenarioScanRoot(context: vscode.ExtensionContext, parameters?: readonly CompilerBuildParameter[]): string {
    if (parameters) {
        const scenario = findCompilerBuildParameter(parameters, 'TestFolder', 'ScenarioFolder');
        const process = findCompilerBuildParameter(parameters, 'TestFolder', 'ProcessFolder');
        currentScenarioScanRoot = scenario?.value.trim() || DEFAULT_SCENARIO_SCAN_ROOT;
        currentProcessScanRoot = process?.value.trim() || '';
        void context.workspaceState.update(SCENARIO_SCAN_ROOT_KEY, currentScenarioScanRoot);
        void context.workspaceState.update(PROCESS_SCAN_ROOT_KEY, currentProcessScanRoot);
        return currentScenarioScanRoot;
    }
    currentProcessScanRoot = String(context.workspaceState.get<string>(PROCESS_SCAN_ROOT_KEY, '') || '').trim();
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


export function getProcessScanRootPath(): string {
    return currentProcessScanRoot || getScenarioScanRootPath();
}

export function resolveProcessScanRootFsPath(workspaceRootUri: vscode.Uri): string {
    const configuredPath = getProcessScanRootPath();
    return path.isAbsolute(configuredPath) ? configuredPath : path.join(workspaceRootUri.fsPath, configuredPath);
}

export async function updateProcessScanRoot(context: vscode.ExtensionContext, nextPath: string): Promise<boolean> {
    const normalized = String(nextPath || '').trim();
    if (normalized === currentProcessScanRoot) { return false; }
    currentProcessScanRoot = normalized;
    await context.workspaceState.update(PROCESS_SCAN_ROOT_KEY, normalized);
    scanRootDidChangeEmitter.fire(getScenarioScanRootPath());
    return true;
}
