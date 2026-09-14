import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
const completionProviderSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'completionProvider.ts'),
    'utf8'
);
const hoverProviderSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'hoverProvider.ts'),
    'utf8'
);
const phaseSwitcherSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'phaseSwitcher.ts'),
    'utf8'
);
const phaseSwitcherConstructorSource = phaseSwitcherSource.slice(
    phaseSwitcherSource.indexOf('    constructor(extensionUri:'),
    phaseSwitcherSource.indexOf('    private async loadLocalizationBundleIfNeeded')
);
const phaseSwitcherResolveWebviewSource = phaseSwitcherSource.slice(
    phaseSwitcherSource.indexOf('    public async resolveWebviewView('),
    phaseSwitcherSource.indexOf('    private async _sendInitialState(')
);

test('activation does not eagerly provision 1C helper infobases', () => {
    assert.doesNotMatch(source, /warmUpSharedStartupInfobase/);
    assert.doesNotMatch(source, /warmUpFormExplorerBuilder/);
    assert.doesNotMatch(source, /ensureOneCClientPathConfigured/);
});

test('activation defers optional panel modules until their commands are used', () => {
    assert.doesNotMatch(source, /import \{ FormExplorerPanel \} from '\.\/formExplorerPanel';/);
    assert.doesNotMatch(source, /import \{ InfobaseManagerPanel \} from '\.\/infobaseManagerPanel';/);
    assert.match(source, /import\('\.\/formExplorerPanel\.js'\)/);
    assert.match(source, /import\('\.\/infobaseManagerPanel\.js'\)/);
});

test('activation defers scenario creation and settings commands', () => {
    assert.doesNotMatch(source, /from '\.\/scenarioCreator';/);
    assert.match(source, /createDeferredLoader\(\s*\(\) => import\('\.\/scenarioCreator\.js'\)\s*\)/);
});

test('completion and hover defer the YAML parameters manager', () => {
    for (const providerSource of [completionProviderSource, hoverProviderSource]) {
        assert.doesNotMatch(providerSource, /from '\.\/yamlParametersManager';/);
        assert.match(providerSource, /import\('\.\/yamlParametersManager\.js'\)/);
    }
});

test('phase switcher defers infobase management helpers', () => {
    assert.doesNotMatch(phaseSwitcherSource, /from '\.\/infobaseManager';/);
    assert.match(
        phaseSwitcherSource,
        /createDeferredLoader\(\s*\(\) => import\('\.\/infobaseManager\.js'\)\s*\)/
    );
});

test('activation defers Form Explorer and 1C platform infrastructure', () => {
    assert.doesNotMatch(source, /from '\.\/formExplorerBuilder';/);
    assert.doesNotMatch(source, /from '\.\/oneCPlatform';/);
    assert.match(source, /import\('\.\/formExplorerBuilder\.js'\)/);
    assert.match(source, /import\('\.\/oneCPlatform\.js'\)/);
});

test('phase switcher defers optional 1C runtime infrastructure', () => {
    assert.doesNotMatch(phaseSwitcherSource, /from '\.\/infobasePicker';/);
    assert.doesNotMatch(
        phaseSwitcherSource,
        /import\s*\{\s*ensureSharedStartupInfobaseReady[\s\S]*?from '\.\/startupInfobase';/
    );
    assert.doesNotMatch(phaseSwitcherSource, /from '\.\/oneCPlatform';/);
    assert.match(phaseSwitcherSource, /import\('\.\/infobasePicker\.js'\)/);
    assert.match(phaseSwitcherSource, /import\('\.\/startupInfobase\.js'\)/);
    assert.match(phaseSwitcherSource, /import\('\.\/oneCPlatform\.js'\)/);
});

test('phase switcher starts background log monitoring only after its view opens', () => {
    assert.doesNotMatch(phaseSwitcherConstructorSource, /startVanessaRuntimeLogMonitor\(\)/);
    assert.match(
        phaseSwitcherResolveWebviewSource,
        /_vanessaRuntimeLogMonitorEnabled = true;\s*this\.startVanessaRuntimeLogMonitor\(\)/
    );
    assert.match(
        phaseSwitcherSource,
        /startVanessaRuntimeLogMonitor\(\): void \{\s*if \(!this\._vanessaRuntimeLogMonitorEnabled\)/
    );
});

test('phase switcher creates its build output channel on demand', () => {
    assert.doesNotMatch(
        phaseSwitcherConstructorSource,
        /createOutputChannel\(["']KOT Test Assembly["']\)/
    );
});
