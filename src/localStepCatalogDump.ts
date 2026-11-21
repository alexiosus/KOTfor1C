import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DirectProcessCancellationToken, DirectProcessResult } from './directProcessLaunch';
import { buildFileInfobaseConnectionArgument } from './oneCInfobaseConnection';

/** The released distribution contains Steps.epf. A temporary empty IB keeps export fully offline. */
export async function withLocalStepTemplate<T>(epf: string | undefined, executable: string,
    run: (args: readonly string[], cwd: string) => Promise<DirectProcessResult>, token: DirectProcessCancellationToken,
    consume: (templatePath: string, sourceDirectory: string) => Promise<T>, sourceEpfs: readonly string[] = [],
    report?: (completed: number, total: number) => void): Promise<T | undefined> {
    if (token.isCancellationRequested) { return; }
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-local-catalog-'));
    try {
        const base = path.join(work, 'base'); const dump = path.join(work, 'dump');
        const sources = path.join(work, 'sources');
        const commands = [
            ['CREATEINFOBASE', buildFileInfobaseConnectionArgument(base, { trailingSemicolon: true }), '/Out', path.join(work, 'create.log')],
            ...(epf ? [['DESIGNER', '/F', base, '/DumpExternalDataProcessorOrReportToFiles', dump, epf,
                '/DisableStartupDialogs', '/DisableStartupMessages', '/Out', path.join(work, 'dump.log')]] : []),
            ...sourceEpfs.filter(file => !epf || path.resolve(file) !== path.resolve(epf)).map((file, index) =>
                ['DESIGNER', '/F', base, '/DumpExternalDataProcessorOrReportToFiles', path.join(sources, String(index)), file,
                    '/DisableStartupDialogs', '/DisableStartupMessages', '/Out', path.join(work, 'dump.log')])
        ];
        await fs.mkdir(sources, { recursive: true });
        let completed = 0;
        for (const args of commands) {
            if (token.isCancellationRequested) { return; }
            const result = await run(args, work);
            if (result.cancelled || token.isCancellationRequested) { return; }
            if (result.exitCode !== 0) {
                const log = await fs.readFile(args.at(-1)!, 'utf8').catch(() => '');
                throw new Error(`Local Vanessa template export failed (${path.basename(executable)}): ${log.slice(-2000) || result.stderr || result.exitCode}`);
            }
            report?.(++completed, commands.length);
        }
        return await consume(path.join(dump, 'Templates', 'en', 'Ext', 'Template.xml'), sources);
    } finally {
        // Only this operation's mkdtemp directory may be removed.
        const target = path.resolve(work);
        if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('kot-local-catalog-')) {
            await fs.rm(target, { recursive: true, force: true });
        }
    }
}
