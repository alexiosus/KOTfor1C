import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { getCompilerBuildParameterValue, type CompilerBuildParameter } from './compilerBuildParameters';
import { parseEtalonBasesYaml, resolveEtalonBasesFilePath } from './etalonBases';

export interface CompilerModelDbStatus {
    state: 'unconfigured' | 'inaccessible' | 'missing' | 'invalid' | 'empty' | 'selectedBaseMissing' | 'noProfiles' | 'ready';
    baseCount: number;
    profileCount: number;
    basesWithoutProfiles: number;
}

/** Return catalog health only. Parser errors and credentials never cross the webview boundary. */
export async function inspectCompilerModelDbStatus(parameters: readonly CompilerBuildParameter[], workspaceRoot: string | null): Promise<CompilerModelDbStatus> {
    const result: CompilerModelDbStatus = { state: 'unconfigured', baseCount: 0, profileCount: 0, basesWithoutProfiles: 0 };
    const configured = getCompilerBuildParameterValue(parameters, 'ModelDBSettings').trim();
    if (!configured) { return result; }
    if (!workspaceRoot || (process.platform !== 'win32' && path.win32.isAbsolute(configured) && !path.isAbsolute(configured))) {
        return { ...result, state: 'inaccessible' };
    }
    let content: string;
    try { content = await fs.readFile(resolveEtalonBasesFilePath(workspaceRoot, configured), 'utf8'); }
    catch (error) { return { ...result, state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'inaccessible' }; }
    try {
        const document = parseDocument(content);
        if (document.errors.length || !isMap(document.contents) || !document.has('ЭталонныеБД')) {
            return { ...result, state: 'invalid' };
        }
        const bases = parseEtalonBasesYaml(content);
        result.baseCount = bases.length;
        result.profileCount = bases.reduce((total, base) => total + base.userProfiles.length, 0);
        result.basesWithoutProfiles = bases.filter(base => !base.userProfiles.length).length;
        const selectedIds = getCompilerBuildParameterValue(parameters, 'ModelDBid').toLowerCase().split(/[; ]+/u).filter(Boolean);
        const selected = selectedIds.length ? bases.filter(base => selectedIds.includes(base.databaseId.toLowerCase())) : bases;
        const selectedBaseMissing = selectedIds.some(id => !bases.some(base => base.databaseId.toLowerCase() === id));
        result.state = !bases.length ? 'empty' : selectedBaseMissing ? 'selectedBaseMissing'
            : selected.some(base => !base.userProfiles.length) ? 'noProfiles' : 'ready';
        return result;
    } catch { return { ...result, state: 'invalid' }; }
}
