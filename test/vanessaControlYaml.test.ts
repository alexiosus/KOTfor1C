import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createCompilerBuildManifest, fingerprintCompilerBuildArtifact, fingerprintCompilerBuildInputs } from '../src/compilerBuildManifest';
import { VanessaYamlControl, type VanessaYamlBuild, type VanessaYamlTarget } from '../src/vanessaControlYaml';
import type { VanessaFeatureDocument } from '../src/vanessaControlFeature';

function fixture() {
    const live = JSON.parse(fs.readFileSync('test/fixtures/compiler-control/compiled-control.live.json', 'utf8'));
    const inputs = fingerprintCompilerBuildInputs(live.sources.map((source: any) => ({ uri: source.uri, content: source.text })), { profile: 'fixture' });
    const manifest = createCompilerBuildManifest({ before: inputs, after: inputs, successful: true,
        artifacts: live.artifacts.map((item: any) => fingerprintCompilerBuildArtifact(item.worker, item.feature, item.featureContent, item.sourceMap, item.sourceMapContent)) });
    const build: VanessaYamlBuild = { inputs, manifest, sources: live.sources, artifacts: live.artifacts, outputRoot: path.resolve('/KOT/output') };
    const source = build.sources.find(item => item.uri.endsWith('/nested/scen.yaml'))!;
    let document: VanessaFeatureDocument = { uri: source.uri, filePath: '/KOT/sources/nested/scen.yaml', text: source.text,
        version: 1, dirty: false, line: source.text.split('\n').findIndex(line => line.trim() === 'And Delay 1') };
    let currentBuild: VanessaYamlBuild | undefined = build;
    const performed: VanessaYamlTarget[] = []; const selections: number[] = []; let reads = 0; let saves = 0; let choices = 0;
    const ports = { current: () => document,
        save: async () => { saves++; document = { ...document, dirty: false }; return true; },
        readText: async () => document.text,
        loadBuild: async () => { reads++; return currentBuild; },
        choose: async (locations: readonly { worker: number; feature: string; lineNumber: number }[]) => { choices++; return locations.at(-1); },
        perform: async (_mode: string, target: VanessaYamlTarget) => { performed.push(target); return { passed: true }; },
        selectLine: (line: number) => selections.push(line) };
    return { build, ports, performed, selections, stats: () => ({ reads, saves, choices }),
        document: () => document, setDocument: (value: Partial<VanessaFeatureDocument>) => { document = { ...document, ...value }; },
        setBuild: (value: VanessaYamlBuild | undefined) => { currentBuild = value; } };
}

test('YAML control saves the native source and asks which exact compiled invocation to execute', async () => {
    const f = fixture(); f.setDocument({ dirty: true });
    await new VanessaYamlControl(f.ports).run('runFromLine');
    assert.deepEqual(f.stats(), { reads: 2, saves: 1, choices: 1 });
    assert.equal(f.performed.length, 1);
    assert.equal(f.performed[0].location.worker, 2); assert.equal(f.performed[0].location.lineNumber, 44);
    assert.equal(f.performed[0].filePath, path.join(f.build.outputRoot, 'part-2', 'KOT', 'KOTPARENT.feature'));
    assert.equal(f.performed[0].featureText, f.build.artifacts[1].featureContent);
});

test('a gutter breakpoint targets the clicked YAML line without moving the editor selection', async () => {
    const f = fixture(); const clickedLine = f.document().line; f.setDocument({ line: 0 });
    await new VanessaYamlControl(f.ports).run('toggleBreakpoint', clickedLine);
    assert.equal(f.performed.length, 1);
    assert.equal(f.document().line, 0);
    assert.equal(f.performed[0].source.line, 0, 'selection guard remains bound to the original cursor');
    assert.equal(f.performed[0].location.lineNumber, 44);
});

test('cancelled or invented invocation choices never run or toggle a breakpoint', async () => {
    for (const invented of [false, true]) {
        const f = fixture(); f.ports.choose = async () => invented ? { worker: 9, feature: '../other.feature', lineNumber: 1 } : undefined;
        const control = new VanessaYamlControl(f.ports);
        if (invented) { await assert.rejects(control.run('toggleBreakpoint'), /selected invocation/u); }
        else { await control.run('toggleBreakpoint'); }
        assert.equal(f.performed.length, 0);
    }
});

test('missing/stale maps and edits while the invocation picker is open cannot execute against a previous build', async () => {
    for (const mode of ['missing', 'stale', 'edited', 'selection', 'buildChanged'] as const) {
        const f = fixture();
        if (mode === 'missing') { f.setBuild(undefined); }
        if (mode === 'stale') { f.setBuild({ ...f.build, manifest: undefined }); }
        if (mode === 'edited' || mode === 'selection' || mode === 'buildChanged') {
            const choose = f.ports.choose;
            f.ports.choose = async values => {
                if (mode === 'edited') { f.setDocument({ text: f.document().text + '# edit', dirty: true }); }
                if (mode === 'selection') { f.setDocument({ line: f.document().line + 1 }); }
                if (mode === 'buildChanged') { f.setBuild({ ...f.build, manifest: undefined }); }
                return choose(values);
            };
        }
        await assert.rejects(new VanessaYamlControl(f.ports).run('oneStep'));
        assert.equal(f.performed.length, 0, mode);
    }
});

test('non-body YAML lines and processes without scenario text are not sent to Vanessa', async () => {
    for (const line of [0, 2, 17, 18, 19]) {
        const f = fixture(); f.setDocument({ line });
        await assert.rejects(new VanessaYamlControl(f.ports).run('oneStep'));
        assert.equal(f.stats().reads, 0); assert.equal(f.performed.length, 0);
    }
    const f = fixture(); const process = f.build.sources.find(item => item.uri.includes('/parent/process.yaml'))!;
    f.setDocument({ ...process, line: 10 });
    await assert.rejects(new VanessaYamlControl(f.ports).run('oneStep'));
    assert.equal(f.performed.length, 0);
});

test('repeated F11 while the map is loading does not queue another execution', async () => {
    const f = fixture(); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.ports.loadBuild = async () => { await pending; return f.build; };
    const control = new VanessaYamlControl(f.ports); const first = control.run('oneStep');
    await assert.rejects(control.run('oneStep'), /busy/u);
    release(); await first; assert.equal(f.performed.length, 1);
});

test('native editor versus disk/source mismatch is rejected before any mutation', async () => {
    for (const mode of ['disk', 'buildSource'] as const) {
        const f = fixture();
        if (mode === 'disk') { f.ports.readText = async () => 'different disk text'; }
        else { f.setDocument({ text: f.document().text.replace('Delay 1', 'Delay 9') }); }
        await assert.rejects(new VanessaYamlControl(f.ports).run('oneStep'));
        assert.equal(f.performed.length, 0);
    }
});
