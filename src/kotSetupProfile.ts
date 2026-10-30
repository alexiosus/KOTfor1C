import path from 'node:path';
import { normalizeCompilerBuildParameters, normalizeBuildParameterKey } from './compilerBuildParameters';
import type { YamlParameter } from './yamlParametersManager';

function projectPath(root: string, value: string): string {
    const absolute = path.resolve(root, value);
    const relative = path.relative(root, absolute);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        ? absolute : relative.split(path.sep).join('/') || '.';
}

/** Clone into a new profile, retaining unrelated compiler options and replacing known aliases once. */
export function setupProfileParameters(current: readonly YamlParameter[], root: string, sources: string, libraries: string): YamlParameter[] {
    const rows = normalizeCompilerBuildParameters(current).filter(item => !['testfolder', 'scenariofolder', 'libraries', 'vanessalibraries', 'featurefolder'].includes(normalizeBuildParameterKey(item.key))).map(item => ({ ...item }));
    const values: Record<string, string> = { ScenarioFolder: projectPath(root, sources), Libraries: libraries.split('|').map(value => value.trim()).filter(Boolean).map(value => projectPath(root, value)).join('|'), FeatureFolder: '.vscode/kot-runtime/features' };
    const separateProcesses = current.some(row => normalizeBuildParameterKey(row.key) === 'processfolder') && !current.some(row => normalizeBuildParameterKey(row.key) === 'testfolder');
    for (const row of rows) { if (normalizeBuildParameterKey(row.key) === 'processfolder') { row.value = projectPath(root, separateProcesses && row.value || sources); } }
    for (const [key, value] of Object.entries(values)) {
        const row = rows.find(row => row.key.toLowerCase() === key.toLowerCase());
        if (row) { row.value = value; } else { rows.push({ key, value }); }
    }
    return rows;
}
