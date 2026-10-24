import path from 'node:path';
import { normalizeCompilerBuildParameters, normalizeBuildParameterKey } from './compilerBuildParameters';
import type { YamlParameter } from './yamlParametersManager';

/** Clone into a new profile, retaining unrelated compiler options and replacing known aliases once. */
export function setupProfileParameters(current: readonly YamlParameter[], root: string, sources: string, libraries: string): YamlParameter[] {
    const rows = normalizeCompilerBuildParameters(current).filter(item => !['testfolder', 'scenariofolder', 'libraries', 'vanessalibraries', 'featurefolder'].includes(normalizeBuildParameterKey(item.key))).map(item => ({ ...item }));
    const values: Record<string, string> = { ScenarioFolder: path.resolve(root, sources), Libraries: libraries.split('|').map(value => value.trim()).filter(Boolean).map(value => path.resolve(root, value)).join('|'), FeatureFolder: path.join(root, '.vscode/kot-runtime/features') };
    const separateProcesses = current.some(row => normalizeBuildParameterKey(row.key) === 'processfolder') && !current.some(row => normalizeBuildParameterKey(row.key) === 'testfolder');
    for (const row of rows) { if (normalizeBuildParameterKey(row.key) === 'processfolder') { row.value = path.resolve(root, separateProcesses && row.value || sources); } }
    for (const [key, value] of Object.entries(values)) {
        const row = rows.find(row => row.key.toLowerCase() === key.toLowerCase());
        if (row) { row.value = value; } else { rows.push({ key, value }); }
    }
    return rows;
}
