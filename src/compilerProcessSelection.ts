import fs from 'node:fs/promises';
import path from 'node:path';
import { getCompilerBuildParameterValue, normalizeBuildParameterKey, type CompilerBuildParameter } from './compilerBuildParameters';
import type { TestInfo } from './types';
import { ScenarioYamlDocument } from './scenarioYamlDocument';

export interface DisabledCompilerProcess { uid: string; name: string }
export interface DisabledProcessSettingsFile { filePath: string; processName: string; settingsCode?: string }

interface ProcessSettingsFile {
    filePath: string;
    processUid: string;
    settingsCode?: string;
    settingsCodeAmbiguous: boolean;
}

async function readProcessSettingsFiles(root: string): Promise<ProcessSettingsFile[]> {
    if (!root) { return []; }
    const result: ProcessSettingsFile[] = [];
    const visit = async (directory: string): Promise<void> => {
        let entries;
        try { entries = await fs.readdir(directory, { withFileTypes: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; } throw error; }
        for (const entry of entries) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) { await visit(file); }
            else if (entry.isFile() && /\.yaml$/iu.test(entry.name)) {
                const document = ScenarioYamlDocument.parse(await fs.readFile(file, 'utf8'));
                const type = document.findFieldAtPath(['ТипФайла']);
                const uid = document.findFieldAtPath(['ДанныеТеста', 'UIDПроцесса']);
                if (type?.ambiguous || uid?.ambiguous) { throw new Error(`Ambiguous process settings: ${file}`); }
                if (String(type?.value).trim().toLowerCase() !== 'настройкапроцесса') { continue; }
                const code = document.findFieldAtPath(['ДанныеТеста', 'Код']);
                const settingsCode = String(code?.value ?? '').trim();
                result.push({ filePath: file, processUid: String(uid?.value ?? '').trim().toLowerCase(),
                    settingsCodeAmbiguous: Boolean(code?.ambiguous), ...(settingsCode ? { settingsCode } : {}) });
            }
        }
    };
    await visit(root);
    return result;
}

/** ProcessFilter is an OR filter in SPPR. Exclude settings, retaining dependency descriptors. */
export async function collectDisabledProcessSettingsFiles(
    root: string, disabled: readonly DisabledCompilerProcess[]
): Promise<DisabledProcessSettingsFile[]> {
    const byUid = new Map(disabled.map(process => [process.uid.trim().toLowerCase(), process.name]));
    if (!byUid.size) { return []; }
    const result: DisabledProcessSettingsFile[] = [];
    for (const setting of await readProcessSettingsFiles(root)) {
        const processName = byUid.get(setting.processUid);
        if (processName === undefined) { continue; }
        if (setting.settingsCodeAmbiguous) { throw new Error(`Ambiguous process settings code: ${setting.filePath}`); }
        result.push({ filePath: setting.filePath, processName, ...(setting.settingsCode ? { settingsCode: setting.settingsCode } : {}) });
    }
    return result;
}


/** Avoid SPPR's faulty ПроцессUID traversal: expand ProcessFilter to equivalent settings codes. */
export async function adaptNestedProcessFilters(
    parameters: readonly CompilerBuildParameter[], processes: readonly TestInfo[], processRoot: string
): Promise<CompilerBuildParameter[]> {
    const filter = getCompilerBuildParameterValue(parameters, 'ProcessFilter');
    if (!filter.trim() || !processes.some(info => info.processSteps?.some(step => step.type === 'process'))) { return parameters.map(row => ({ ...row })); }
    const codes = new Set(filter.split(';').map(code => code.trim().toLowerCase()).filter(Boolean));
    const byUid = new Map(processes.filter(info => info.uid).map(info => [info.uid!.toLowerCase(), info]));
    const includes = (root: TestInfo): boolean => {
        const queue = [root]; const visited = new Set<string>();
        while (queue.length) {
            const current = queue.pop()!;
            const uid = current.uid?.toLowerCase();
            if (!uid || visited.has(uid)) { continue; }
            visited.add(uid);
            if (codes.has((current.processCode || current.scenarioCode || '').toLowerCase())) { return true; }
            for (const step of current.processSteps ?? []) {
                const child = step.type === 'process' && step.processUid ? byUid.get(step.processUid.toLowerCase()) : undefined;
                if (child) { queue.push(child); }
            }
        }
        return false;
    };
    const selectedUids = new Set(processes.filter(info => info.uid && includes(info)).map(info => info.uid!.trim().toLowerCase()));
    const inventory = await readProcessSettingsFiles(processRoot);
    const settings = inventory.filter(setting => selectedUids.has(setting.processUid));
    const allowed = new Set(getCompilerBuildParameterValue(parameters, 'ProcessSettingsFilter').split(';').map(code => code.trim()).filter(Boolean));
    const explicitCodes = new Set([...allowed].map(code => code.toLowerCase()));
    const generatedCodes = new Set<string>();
    for (const setting of settings) {
        if (setting.settingsCodeAmbiguous) { throw new Error(`Ambiguous process settings code: ${setting.filePath}`); }
        if (!setting.settingsCode) { throw new Error(`Process settings code is missing: ${setting.filePath}`); }
        allowed.add(setting.settingsCode);
        generatedCodes.add(setting.settingsCode.toLowerCase());
    }
    for (const setting of inventory) {
        if (selectedUids.has(setting.processUid)) { continue; }
        if (setting.settingsCodeAmbiguous) { throw new Error(`Ambiguous process settings code: ${setting.filePath}`); }
        const code = setting.settingsCode?.toLowerCase();
        // SPPR compares settings by code only, even when their process UIDs differ.
        if (code && generatedCodes.has(code) && !explicitCodes.has(code)) {
            throw new Error(`Process settings code "${setting.settingsCode}" also belongs to an unselected process: ${setting.filePath}`);
        }
    }
    return [...parameters.filter(row => !['processfilter', 'processsettingsfilter'].includes(normalizeBuildParameterKey(row.key))),
        { key: 'ProcessSettingsFilter', value: [...allowed].join(';') || '__KOT_NO_MATCHING_PROCESS_SETTINGS__' }];
}
