import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    buildUserStepLibrary,
    type UserStepLibraryBuildDependencies,
    type UserStepLibraryBuildRequest
} from '../src/userStepLibraryBuilder';

interface Harness {
    readonly directory: string;
    readonly request: UserStepLibraryBuildRequest;
    readonly commands: Array<{ executable: string; args: readonly string[]; cwd: string }>;
    readonly dependencies: UserStepLibraryBuildDependencies;
}

async function createHarness(options?: {
    authentication?: { username: string; password: string } | null;
    exitCode?: number;
    output?: 'valid' | 'missing' | 'empty';
}): Promise<Harness> {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kot-user-step-build-'));
    const sourceDirectory = path.join(directory, 'step_definitions-src', 'CustomSteps');
    const rootXmlPath = path.join(sourceDirectory, 'Обработка.xml');
    const targetEpfPath = path.join(directory, 'step_definitions', 'CustomSteps.epf');
    await fs.promises.mkdir(sourceDirectory, { recursive: true });
    await fs.promises.mkdir(path.dirname(targetEpfPath), { recursive: true });
    await fs.promises.writeFile(rootXmlPath, '<processor/>');
    await fs.promises.writeFile(targetEpfPath, 'old epf');
    const commands: Array<{ executable: string; args: readonly string[]; cwd: string }> = [];
    const dependencies: UserStepLibraryBuildDependencies = {
        pickPlatform: async () => ({ clientExePath: 'C:\\1C\\bin\\1cv8c.exe' }),
        ensureStartupInfobase: async () => ({
            infobaseDirectory: 'C:\\KOT\\startup-infobase',
            authentication: options?.authentication ?? null
        }),
        runProcess: async command => {
            commands.push(command);
            const loadIndex = command.args.indexOf('/LoadExternalDataProcessorOrReportFromFiles');
            const temporaryEpf = command.args[loadIndex + 2];
            if ((options?.output ?? 'valid') === 'valid') {
                await fs.promises.writeFile(temporaryEpf, 'new epf');
            } else if (options?.output === 'empty') {
                await fs.promises.writeFile(temporaryEpf, '');
            }
            return { exitCode: options?.exitCode ?? 0, stdout: '', stderr: '' };
        },
        fileSystem: {
            mkdir: (target, options) => fs.promises.mkdir(target, options).then(() => undefined),
            stat: target => fs.promises.stat(target),
            rename: (from, to) => fs.promises.rename(from, to),
            rm: (target, options) => fs.promises.rm(target, options)
        },
        now: () => 1700000000000,
        resolveDesignerPath: () => 'C:\\1C\\bin\\1cv8.exe'
    };
    return {
        directory,
        request: { rootXmlPath, targetEpfPath },
        commands,
        dependencies
    };
}

test('builds beside the target with the exact unauthenticated Designer argument array', async t => {
    const harness = await createHarness();
    t.after(() => fs.promises.rm(harness.directory, { recursive: true, force: true }));

    const result = await buildUserStepLibrary(harness.request, harness.dependencies, {
        isCancellationRequested: false
    });

    const expectedTemporary = path.join(
        path.dirname(harness.request.targetEpfPath),
        '.CustomSteps.kot-build-1700000000000.epf'
    );
    const expectedLog = path.join(
        path.dirname(harness.request.targetEpfPath),
        '.CustomSteps.kot-build-1700000000000.log'
    );
    assert.deepEqual(harness.commands, [{
        executable: 'C:\\1C\\bin\\1cv8.exe',
        cwd: path.dirname(harness.request.rootXmlPath),
        args: [
            'DESIGNER',
            '/IBConnectionString', 'File=C:\\KOT\\startup-infobase;',
            '/LoadExternalDataProcessorOrReportFromFiles', harness.request.rootXmlPath, expectedTemporary,
            '/DisableStartupDialogs', '/DisableStartupMessages',
            '/Out', expectedLog
        ]
    }]);
    assert.equal(result.kind, 'success');
    assert.equal(await fs.promises.readFile(harness.request.targetEpfPath, 'utf8'), 'new epf');
    await assert.rejects(() => fs.promises.stat(expectedTemporary), /ENOENT/u);
});

test('inserts startup-infobase authentication as separate /N and /P arguments', async t => {
    const harness = await createHarness({
        authentication: { username: 'KOTStartupService', password: 'secret' }
    });
    t.after(() => fs.promises.rm(harness.directory, { recursive: true, force: true }));

    await buildUserStepLibrary(harness.request, harness.dependencies, { isCancellationRequested: false });

    assert.deepEqual(harness.commands[0].args.slice(0, 9), [
        'DESIGNER',
        '/IBConnectionString', 'File=C:\\KOT\\startup-infobase;',
        '/N', 'KOTStartupService',
        '/P', 'secret',
        '/LoadExternalDataProcessorOrReportFromFiles', harness.request.rootXmlPath
    ]);
});

for (const failure of [
    { name: 'non-zero process exit', options: { exitCode: 1, output: 'valid' as const } },
    { name: 'missing temporary output', options: { output: 'missing' as const } },
    { name: 'zero-byte temporary output', options: { output: 'empty' as const } }
]) {
    test(`${failure.name} preserves the existing EPF and removes only the temporary artifact`, async t => {
        const harness = await createHarness(failure.options);
        t.after(() => fs.promises.rm(harness.directory, { recursive: true, force: true }));

        await assert.rejects(
            () => buildUserStepLibrary(harness.request, harness.dependencies, { isCancellationRequested: false }),
            /build|output/iu
        );
        assert.equal(await fs.promises.readFile(harness.request.targetEpfPath, 'utf8'), 'old epf');
        const remaining = await fs.promises.readdir(path.dirname(harness.request.targetEpfPath));
        assert.deepEqual(remaining, ['CustomSteps.epf']);
    });
}

test('cancellation before platform selection makes no filesystem or process changes', async t => {
    const harness = await createHarness();
    t.after(() => fs.promises.rm(harness.directory, { recursive: true, force: true }));
    let picked = false;
    const result = await buildUserStepLibrary(harness.request, {
        ...harness.dependencies,
        pickPlatform: async () => {
            picked = true;
            return { clientExePath: 'unused' };
        }
    }, { isCancellationRequested: true });

    assert.deepEqual(result, { kind: 'cancelled' });
    assert.equal(picked, false);
    assert.equal(harness.commands.length, 0);
    assert.equal(await fs.promises.readFile(harness.request.targetEpfPath, 'utf8'), 'old epf');
});
