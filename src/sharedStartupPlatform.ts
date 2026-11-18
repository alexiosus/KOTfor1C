import path from 'node:path';
import type { Translator } from './localization';
import { normalizeOneCClientExePath, resolveOneCPlatformForLaunch, type ConfiguredOneCPlatform } from './oneCPlatform';
import { OneCInfobasePlatformError, runningOneCInfobasePlatform } from './oneCInfobasePlatform';
import { getSharedStartupInfobasePaths } from './startupInfobase';

/** Every non-legacy consumer of the shared service IB uses the same platform policy. */
export async function resolveSharedStartupPlatform(t: Translator): Promise<ConfiguredOneCPlatform | null> {
    const paths = getSharedStartupInfobasePaths();
    if (!paths) { throw new Error(t('Project folder must be opened.')); }
    let running: string | undefined;
    try { running = await runningOneCInfobasePlatform(paths.infobaseDirectory); }
    catch (error) {
        throw new Error(error instanceof OneCInfobasePlatformError && error.reason === 'conflict'
            ? t('Several 1C platforms are using the KOT service infobase. Close the conflicting sessions before continuing.')
            : t('Could not determine the platform of the KOT service infobase. The operation was cancelled to avoid using a different 1C version.'));
    }
    return running ? { name: path.basename(path.dirname(path.dirname(running))), clientExePath: normalizeOneCClientExePath(running) }
        : resolveOneCPlatformForLaunch(t, { promptUser: false });
}
