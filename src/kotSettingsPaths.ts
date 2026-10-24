import path from 'node:path';
import type { SettingsScope } from './kotSettingsSession';

export type SettingPathPolicy = 'relative' | 'absolute' | 'project';
/** Use the selected folder, with segment-aware containment; never invent ../ paths for external tools. */
export function portableSettingPath(root: string, selected: string, policy: SettingPathPolicy, scope: SettingsScope, platform: string = process.platform): string {
    const api = platform === 'win32' ? path.win32 : path.posix;
    if (!api.isAbsolute(root) || !api.isAbsolute(selected)) { throw new Error('Choose an absolute file system path'); }
    const full = api.normalize(selected); const relative = api.relative(root, full);
    const inside = relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
    if (policy === 'project' && !inside) { throw new Error('Choose a file inside the selected project'); }
    return inside && policy !== 'absolute' && (scope !== 'user' || policy === 'project') ? relative.split(api.sep).join('/') || '.' : full;
}
