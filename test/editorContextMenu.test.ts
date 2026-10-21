import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
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

test('editor aliases use the shared dispatcher and point to contributed commands', () => {
    const commands = new Set(manifest.contributes.commands.map((item: { command: string }) => item.command));
    const registrations = fs.readdirSync('src').filter(file => file.endsWith('.ts'))
        .flatMap(file => [...fs.readFileSync(`src/${file}`, 'utf8').matchAll(/registerCommand\(['"]([^'"]+)['"]/gu)].map(match => match[1]));
    for (const id of commands) {
        if (typeof id !== 'string' || !id.startsWith('kotTestToolkit.editorMenu.')) { continue; }
        assert.ok(!registrations.includes(id), `${id} must not be registered twice during activation`);
        assert.ok(commands.has(id.replace('kotTestToolkit.editorMenu.', 'kotTestToolkit.')), `${id} needs a real dispatch target`);
    }
});

test('Vanessa F11 applies to ready feature and YAML steps, preserving other files and active debuggers', () => {
    const keybinding = manifest.contributes.keybindings.find((item: any) => item.command === 'kotTestToolkit.vanessaControl.oneStep');
    assert.equal(keybinding.key, 'f11');
    for (const ext of ['.feature', '.yaml', '.md', '.json']) {
        for (const ready of [false, true]) {
            for (const focused of [false, true]) {
                for (const debugging of [false, true]) {
                    const when = keybinding.when.replace(/resourceExtname\s*==\s*(\.[a-z]+)/giu,
                        (_: string, value: string) => String(value === ext));
                    const active = vm.runInNewContext(when, { editorTextFocus: focused, inDebugMode: debugging,
                        kotTestToolkit: { vanessaControlCanStep: ready } });
                    assert.equal(active, ['.feature', '.yaml'].includes(ext) && ready && focused && !debugging, `${ext},${ready},${focused},${debugging}`);
                }
            }
        }
    }
});

test('runtime variables start collapsed in the properties sidebar', () => {
    const view = manifest.contributes.views.kotTestToolkitPropertiesContainer.find((item: any) => item.id === 'kotTestToolkit.vanessaVariables');
    assert.equal(view.visibility, 'collapsed');
    assert.equal(view.when, undefined, 'the collapsed view is discoverable without a palette command');
});
