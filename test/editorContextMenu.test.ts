import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const nls = JSON.parse(fs.readFileSync('package.nls.json', 'utf8'));
test('editor context has a single KOT submenu with concise command aliases', () => {
    const menus = manifest.contributes.menus;
    assert.deepEqual(menus['editor/context'].map((entry: any) => entry.submenu), ['kotTestToolkit.editorContext']);
    assert.equal(menus['editor/context'][0].group, 'navigation@99', 'KOT appears immediately before the built-in Peek submenu (order 100)');
    const entries = Object.entries(menus).filter(([key]) => key.startsWith('kotTestToolkit.editorContext')).flatMap(([, value]) => value as any[]);
    const ids = entries.filter(entry => entry.command).map(entry => entry.command);
    assert.ok(ids.includes('kotTestToolkit.editorMenu.openScenarioEditor'));
    assert.ok(!ids.includes('kotTestToolkit.editorMenu.openSubscenario'), 'F12 replaces the redundant YAML navigation item');
    for (const id of ids) {
        const command = manifest.contributes.commands.find((item: any) => item.command === id);
        assert.ok(command, id);
        assert.ok(!String(nls[command.title.slice(1, -1)] ?? command.title).startsWith('KOT -'), id);
        assert.ok(menus.commandPalette.some((item: any) => item.command === id && item.when === 'false'));
    }
});
