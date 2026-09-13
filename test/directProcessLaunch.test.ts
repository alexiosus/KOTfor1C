import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDirectSpawnCommand } from '../src/directProcessLaunch';

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
