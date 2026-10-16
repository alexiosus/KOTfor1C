import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

test('routine webview logging is quiet by default and emitted only for advanced logging', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'media/phaseSwitcher.js'), 'utf8');
    const functionSource = source.slice(source.indexOf('    function log(message)'), source.indexOf('\n    function renderMainStatusBar', source.indexOf('    function log(message)')));
    const posted: unknown[] = []; const logged: unknown[] = []; const settings = { advancedLoggingEnabled: false };
    const context = { settings, vscode: { postMessage: (message: unknown) => posted.push(message) }, console: { log: (...args: unknown[]) => logged.push(args), debug: (...args: unknown[]) => logged.push(args) } };
    vm.runInNewContext(functionSource + '\nlog("Applying states to visible checkboxes...");', context);
    assert.equal(posted.length, 0); assert.equal(logged.length, 0);
    settings.advancedLoggingEnabled = true;
    vm.runInNewContext('log("Applying states to visible checkboxes...");', context);
    assert.equal(posted.length, 1); assert.equal(logged.length, 1);
});
