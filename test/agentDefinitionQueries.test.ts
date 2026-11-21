import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { agentCallGraph, agentReferences } from '../src/agentDefinitionQueries';
import { AgentWorkspace } from '../src/agentWorkspace';
import { createProjectDefinitionView, normalizeProjectDefinitionTemplate, type ProjectDefinition } from '../src/projectDefinition';
import { resolveProjectInvocation } from '../src/projectDefinitionMatcher';
import { parseExportScenarios } from '../src/exportScenarioParser';
import { withKotInteraction } from '../src/kotInteraction';

const uri = (file: string): any => ({ fsPath: file, toString: () => pathToFileURL(file).href });
async function fixture(t: test.TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-agent-definitions-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const definitions: ProjectDefinition[] = []; const catalog: any[] = [];
    const write = async (name: string, text: string) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return file; };
    const define = (file: string, template: string, id: string): ProjectDefinition => ({
        id, kind: 'nestedScenario', template, normalizedTemplate: normalizeProjectDefinitionTemplate(template), sourceLabel: 'Fixture',
        parameters: template.includes('"Amount"') ? [{ name: 'Amount', source: 'snippet', index: 0 }] : [],
        definitionLocation: { uri: pathToFileURL(file).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }
    });
    let identity = 'first';
    const ports: any = { provider: { ensureFreshScenarioCatalog: async () => ({ all: catalog }) },
        definitions: { getView: async () => createProjectDefinitionView(identity, definitions),
            resolve: async (_source: unknown, text: string, view: ReturnType<typeof createProjectDefinitionView>) => resolveProjectInvocation(view, text) } };
    return { root, write, define, definitions, catalog, ports, workspace: new AgentWorkspace(root), change: () => { identity = 'changed'; } };
}

test('call graphs preserve repeated arguments, native bodies, process steps, ambiguity and real cycles', async t => {
    const h = await fixture(t);
    const main = await h.write('main.feature', 'Feature: Main\nScenario: Main\n And Check\n Amount = "400"\n And Check\n Amount = "[Expected]"\n And Ambiguous\n """\n And Hidden\n """\n # And Hidden\n');
    const meta = await h.write('nested/meta.yaml', 'ДанныеСценария:\n    Имя: Check\n');
    await h.write('nested/scen.feature', 'And Check\n Amount = "400"\nThen leaf check\n');
    h.definitions.push(h.define(meta, 'Check', 'nested'), h.define(main, 'Ambiguous', 'ambiguous-a'), h.define(meta, 'Ambiguous', 'ambiguous-b'));
    const graph = await agentCallGraph(h.ports, h.workspace, uri(main), {});
    assert.equal(graph.staticAnalysis, true); assert.equal(graph.truncated, false);
    const calls = graph.edges.filter(value => value.definitionId === 'nested');
    assert.equal(calls.length, 3); assert.equal((calls[0].bindings as any[])[0].value, '"400"');
    assert.equal((calls[1].bindings as any[])[0].value, '"[Expected]"');
    assert.ok(calls.some(value => value.cycle === true));
    assert.equal(graph.edges.filter(value => value.ambiguous).length, 2);
    assert.ok(!JSON.stringify(graph.edges).includes('Hidden'));
    assert.ok(graph.nodes.some(value => value.source.endsWith('/nested/scen.feature')));
    assert.equal((await agentCallGraph(h.ports, h.workspace, uri(main), { depth: 0 })).truncated, true);
    assert.equal((await agentCallGraph(h.ports, h.workspace, uri(main), { limit: 1 })).truncated, true);
    const process = await h.write('process.yaml', 'ДанныеПроцесса:\n    Имя: Flow\n');
    h.catalog.push({ kind: 'process', uid: 'flow', name: 'Flow', yamlFileUri: uri(process), processSteps: [
        { type: 'scenario', scenarioUid: 'nested-id' }, { type: 'process', processUid: 'flow' }
    ] }, { kind: 'scenario', uid: 'nested-id', name: 'Check', yamlFileUri: uri(meta) });
    const flow = await agentCallGraph(h.ports, h.workspace, uri(process), {});
    assert.equal(flow.edges[0].step, 0); assert.equal((flow.edges[0].targets as string[])[0], uri(meta).toString());
    assert.ok(flow.nodes.some(value => value.uri === uri(meta).toString()));
});

test('call graphs expand the called exported scenario without mixing another scenario from the same feature', async t => {
    const h = await fixture(t);
    const text = '@ExportScenarios\nFeature: Library\nScenario: First\n And First leaf\nScenario: Second\n And Second leaf\n';
    const library = await h.write('library.feature', text);
    h.definitions.push(...parseExportScenarios(text, { sourceUri: uri(library).toString(), workspaceFolderUri: '', profileId: '', libraryRootUri: '', sourceLabel: '', defaultLanguage: 'en' }).definitions,
        { ...h.define(library, 'First leaf', 'first-leaf'), kind: 'builtInStep' }, { ...h.define(library, 'Second leaf', 'second-leaf'), kind: 'builtInStep' });
    const main = await h.write('main.feature', 'Feature: Main\nScenario: Main\n And First\n');
    const first = await agentCallGraph(h.ports, h.workspace, uri(main), {});
    assert.ok(first.edges.some(value => value.definitionId === 'first-leaf'));
    assert.ok(!first.edges.some(value => value.definitionId === 'second-leaf'));
    await fs.appendFile(main, ' And Second\n');
    const both = await agentCallGraph(h.ports, h.workspace, uri(main), {});
    assert.ok(both.edges.some(value => value.definitionId === 'first-leaf'));
    assert.ok(both.edges.some(value => value.definitionId === 'second-leaf'));
});

test('references use the shared complete-scan service, paginate and preserve source evidence', async t => {
    const h = await fixture(t); const nested = await h.write('nested.yaml', 'ТекстСценария: |\n    And Leaf\n');
    const main = await h.write('main.feature', 'And Check\nAnd Check\n');
    h.definitions.push(h.define(nested, 'Check', 'nested'));
    let scanOptions: unknown;
    h.ports.references = { findReferencesForDefinitions: async (_ids: string[], _source: unknown, options: unknown) => {
        scanOptions = options;
        return new Map([['nested', [0, 1].map(line => ({ uri: uri(main), range: { start: { line, character: 4 }, end: { line, character: 9 } } }))]]);
    } };
    const result = await agentReferences(h.ports, h.workspace, uri(nested), { limit: 1 });
    assert.deepEqual(scanOptions, { includeDeclaration: false, failOnScanError: true });
    assert.equal(result.total, 2); assert.equal(result.nextOffset, 1); assert.equal(result.references[0].invocation, 'And Check');
    assert.match(result.references[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal((await agentReferences(h.ports, h.workspace, uri(nested), { offset: 1 })).references[0].range.start.line, 1);
    h.ports.references.findReferencesForDefinitions = async () => { h.change(); return new Map(); };
    await assert.rejects(agentReferences(h.ports, h.workspace, uri(nested), {}), /changed during/);
});

test('query limits do not grant external access and cancellation never returns a complete graph', async t => {
    const h = await fixture(t); const file = await h.write('main.feature', 'Feature: Main\nScenario: Main\n And External\n');
    h.definitions.push(h.define(path.join(h.root, '..', 'outside-source'), 'External', 'external'));
    await assert.rejects(agentCallGraph(h.ports, h.workspace, uri(file), {}), /outside|ENOENT/);
    await assert.rejects(withKotInteraction({ token: { isCancellationRequested: true }, ask: async () => ({}), notify() {}, progress() {}, resolvePath: async () => {} },
        () => agentCallGraph(h.ports, h.workspace, uri(file), {})), /cancelled/);
});
