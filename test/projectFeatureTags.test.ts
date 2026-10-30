import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as annotations from '../src/gherkinAnnotations';

function catalogHarness() {
    const file = path.join(process.cwd(), 'src/projectFeatureTags.ts');
    const ts = require(path.join(process.cwd(), 'node_modules/typescript')) as typeof import('typescript');
    const moduleObject = { exports: {} as Record<string, any> };
    if (fs.existsSync(file)) {
        vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText, { module: moduleObject, exports: moduleObject.exports, require: () => annotations });
    }
    const texts = new Map([
        ['file:///a.feature', '@Smoke\nFeature: A\n@team.sales\nScenario: One\n    @screenshot\n    Given ready\n'],
        ['file:///b.feature', '@Issue=123\nFeature: B\nScenario: Two\n    Given ready\n'],
        ['file:///other.feature', '@OtherProject\nFeature: Other\n']
    ]);
    let sources = ['file:///a.feature', 'file:///b.feature'];
    let open: { uri: string; text: string }[] = [];
    let reads = 0;
    assert.equal(typeof moduleObject.exports.ProjectFeatureTagCatalog, 'function');
    const catalog = new moduleObject.exports.ProjectFeatureTagCatalog({
        loadSources: async () => sources,
        readSource: async (uri: string) => { reads++; return texts.get(uri)!; },
        getOpenSources: () => open
    });
    return { catalog, texts, get reads() { return reads; }, setSources(value: string[]) { sources = value; }, setOpen(value: typeof open) { open = value; } };
}

test('project tags reuse cached feature reads and live text overrides disk without leaking other projects', async () => {
    const h = catalogHarness();
    assert.deepEqual(Array.from(await h.catalog.getTags()), ['@Issue=123', '@Smoke', '@team.sales']);
    assert.equal(h.reads, 2);
    h.setOpen([{ uri: 'file:///a.feature', text: '@Unsaved\nFeature: A\n' }, { uri: 'file:///other.feature', text: '@ForeignUnsaved\nFeature: Other\n' }]);
    assert.deepEqual(Array.from(await h.catalog.getTags()), ['@Issue=123', '@Unsaved']);
    assert.equal(h.reads, 2);
    h.setOpen([]);
    assert.deepEqual(Array.from(await h.catalog.getTags()), ['@Issue=123', '@Smoke', '@team.sales']);
    assert.equal(h.reads, 2);
});

test('project tag cache follows changed and deleted files after catalog invalidation', async () => {
    const h = catalogHarness();
    await h.catalog.getTags();
    h.texts.set('file:///a.feature', '@Updated\nFeature: A\n');
    h.setSources(['file:///a.feature']);
    h.catalog.invalidate();
    assert.deepEqual(Array.from(await h.catalog.getTags()), ['@Updated']);
    assert.equal(h.reads, 3);
});

test('project tag collection ignores payloads, metadata, comments and step tags while preserving user punctuation', () => {
    const source = '\uFEFF@Smoke @team.sales @priority:high\n@ExportScenarios\nFeature: Tags\n# @Comment\n@issue=123\nScenario: Run\n@description: uses @Fake\n    @screenshot\n    @StepOnly\n    Given payload\n    """\n    @Payload\n    Scenario: Fake\n    """\n    | @Table |\n';
    assert.deepEqual(annotations.collectGherkinProjectTags({ text: source, uri: 'file:///tags.feature', language: 'en' }), ['@Smoke', '@team.sales', '@priority:high', '@issue=123']);
});
