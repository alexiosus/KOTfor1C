import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDirectSpawnCommand, runDirectProcess } from '../src/directProcessLaunch';

test('keeps executable paths and arguments separate from the shell', () => {
    const executable = 'C:\\Program Files\\1C\\1cv8c.exe';
    const args = [
        '/Execute',
        'C:\\Scenario files\\runner & tools.epf',
        '/CBuild;Result=C:\\Output (current)\\result.txt;'
    ];

    const command = buildDirectSpawnCommand(executable, args);

    assert.equal(command.executable, executable);
    assert.deepEqual(command.args, args);
    assert.notEqual(command.args, args);
    assert.equal(command.shell, false);
});

test('runs a direct process, captures output and redacts the displayed command', async () => {
    const displayed: string[] = [];
    const result = await runDirectProcess(
        buildDirectSpawnCommand(process.execPath, [
            '-e',
            'process.stdout.write("ok"); process.stderr.write("warning")',
            '/P',
            'secret'
        ]),
        {
            token: { isCancellationRequested: false },
            onCommand: value => displayed.push(value)
        }
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'ok');
    assert.equal(result.stderr, 'warning');
    assert.equal(result.cancelled, false);
    assert.equal(displayed.length, 1);
    assert.equal(displayed[0].includes('secret'), false);
});

test('does not spawn a process when cancellation was already requested', async () => {
    const result = await runDirectProcess(
        buildDirectSpawnCommand(process.execPath, ['-e', 'process.exit(99)']),
        { token: { isCancellationRequested: true } }
    );

    assert.deepEqual(result, { exitCode: -1, stdout: '', stderr: '', cancelled: true });
});
