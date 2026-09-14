import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');

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
