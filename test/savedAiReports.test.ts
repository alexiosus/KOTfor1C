import { nativeInteraction } from './helpers/kotInteraction';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

class Uri {
    constructor(readonly fsPath: string) {}
    static file(file: string) { return new Uri(path.resolve(file)); }
    static joinPath(base: Uri, ...parts: string[]) { return Uri.file(path.join(base.fsPath, ...parts)); }
    toString() { return pathToFileURL(this.fsPath).href; }
}

async function fixture(t: test.TestContext) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kot saved reports ')));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '--initial-branch=feature/10891');
    const configuration = path.join(root, 'cf'); const tests = path.join(root, 'tests', 'RegressionTests', 'yaml');
    await fs.mkdir(configuration); await fs.mkdir(tests, { recursive: true });
    let runtime = ''; let configuredTests = 'tests/RegressionTests/yaml'; let configuredSource: string | undefined = configuration;
    let workspace = true; let previewError = false;
    const opened: Array<{ command: string; file: string }> = [];
    const host = {
        Uri,
        workspace: {
            get workspaceFolders() { return workspace ? [{ uri: Uri.file(root) }] : undefined; },
            getWorkspaceFolder: () => workspace ? { uri: Uri.file(root) } : undefined,
            getConfiguration: () => ({ get: () => runtime }),
            fs: { stat: (uri: Uri) => fs.stat(uri.fsPath) }
        },
        commands: { executeCommand: (command: string, uri: Uri) => {
            if (previewError) { throw new Error('Preview unavailable'); }
            opened.push({ command, file: uri.fsPath });
        } }
    };
    const module = { exports: {} as { openSavedConfigurationDiffImpactReport(): Promise<boolean>; openSavedTestReviewReport(): Promise<boolean> } };
    const dependencies: Record<string, unknown> = {
        vscode: host,
        './formExplorerPaths': { getFormExplorerConfigurationSourceDirectory: () => configuredSource },
        './scenarioScanRoot': { getScenarioScanRootPath: () => configuredTests }
    };
    const source = readFileSync(path.resolve('src/savedAiReports.ts'), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { module, exports: module.exports, require: (name: string) => name === './kotInteraction' ? nativeInteraction : (name in dependencies ? dependencies[name] : require(name)) });
    async function save(kind: string, name = 'feature_10891--68f76daf.md') {
        const file = path.join(runtime ? path.resolve(root, runtime) : path.join(root, '.vscode', 'kot-runtime'), `${kind}-ai-reports`, name);
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '# Existing report\n'); return file;
    }
    return { ...module.exports, root, git, save, opened,
        runtime(value: string) { runtime = value; }, tests(value: string) { configuredTests = value; },
        source(value: string | undefined) { configuredSource = value; }, workspace(value: boolean) { workspace = value; },
        failPreview() { previewError = true; } };
}

test('both saved report commands retain original branch filenames and never modify reports', async t => {
    const h = await fixture(t);
    const configuration = await h.save('configuration-diff'); const review = await h.save('test-review');
    assert.equal(await h.openSavedConfigurationDiffImpactReport(), true);
    assert.equal(await h.openSavedTestReviewReport(), true);
    assert.deepEqual(h.opened, [{ command: 'markdown.showPreviewToSide', file: configuration }, { command: 'markdown.showPreviewToSide', file: review }]);
    assert.equal(await fs.readFile(configuration, 'utf8'), '# Existing report\n');
    assert.equal(await fs.readFile(review, 'utf8'), '# Existing report\n');
    h.git('symbolic-ref', 'HEAD', 'refs/heads/feature_10891');
    assert.equal(await h.openSavedTestReviewReport(), false, 'similar branch names must not open another branch report');
});

test('report lookup supports relative and absolute runtimes and absolute scan roots without a workspace', async t => {
    const h = await fixture(t);
    h.runtime('custom runtime'); const configuration = await h.save('configuration-diff');
    assert.equal(await h.openSavedConfigurationDiffImpactReport(), true);
    assert.equal(h.opened.at(-1)?.file, configuration);
    h.runtime(path.join(h.root, 'absolute runtime')); h.tests(path.join(h.root, 'tests/RegressionTests/yaml')); h.workspace(false);
    const review = await h.save('test-review');
    assert.equal(await h.openSavedTestReviewReport(), true);
    assert.equal(h.opened.at(-1)?.file, review);
});

test('missing reports, sources, workspace and git repositories do not generate files', async t => {
    const h = await fixture(t);
    assert.equal(await h.openSavedConfigurationDiffImpactReport(), false);
    assert.equal(await h.openSavedTestReviewReport(), false);
    await assert.rejects(fs.stat(path.join(h.root, '.vscode')), { code: 'ENOENT' });
    h.source(undefined); assert.equal(await h.openSavedConfigurationDiffImpactReport(), false);
    h.source(path.join(h.root, 'missing')); assert.equal(await h.openSavedConfigurationDiffImpactReport(), false);
    h.tests('missing'); assert.equal(await h.openSavedTestReviewReport(), false);
    h.workspace(false); assert.equal(await h.openSavedTestReviewReport(), false);
    await fs.rm(path.join(h.root, '.git'), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    h.tests(h.root); assert.equal(await h.openSavedTestReviewReport(), false);
    assert.deepEqual(h.opened, []);
});

test('detached HEAD retains its original report filename and preview failures propagate', async t => {
    const h = await fixture(t);
    h.git('-c', 'user.name=KOT test', '-c', 'user.email=kot@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Fixture');
    h.git('checkout', '--detach');
    const report = await h.save('test-review', 'HEAD--305a7fc3.md');
    assert.equal(await h.openSavedTestReviewReport(), true);
    assert.equal(h.opened[0].file, report);
    h.failPreview(); await assert.rejects(h.openSavedTestReviewReport(), /Preview unavailable/u);
});

test('extension exposes agent setup and saved reports without direct LLM commands or settings', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    const surface = JSON.stringify(manifest.contributes);
    for (const name of ['generateScenarioDescriptionWithAi', 'generateConfigurationDiffImpactReportWithAi', 'reviewChangedTestsWithAi', 'kotTestToolkit.ai.']) {
        assert.ok(!surface.includes(name), name);
    }
    for (const command of ['agent.setup', 'openConfigurationDiffReport', 'openTestReviewReport']) {
        assert.ok(manifest.contributes.commands.some((item: { command: string }) => item.command === `kotTestToolkit.${command}`));
    }
});
