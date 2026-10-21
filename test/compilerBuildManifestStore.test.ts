import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyCompilerBuildManifest } from '../src/compilerBuildManifest';
import {
    captureCompilerBuildInputs, invalidateCompilerBuildManifest, publishCompilerBuildManifest,
    readCompilerBuildManifest, readCompilerBuildManifestArtifacts, COMPILER_BUILD_MANIFEST_NAME
} from '../src/compilerBuildManifestStore';

const map = JSON.stringify({ ДанныеНомеровСтрок: [{ UIDСценария: 'main', СтрокаЛин: 4, СтрокаОриг: 1, Уровень: 0 }] });

async function fixture(t: { after(fn: () => Promise<void>): void }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-manifest-store-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const sources = path.join(root, 'sources'); const output = path.join(root, 'output');
    await fs.mkdir(path.join(sources, '.hidden', 'nested'), { recursive: true });
    const write = async (name: string, content: string) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); return file; };
    const compilerPath = await write('compiler.epf', 'compiler bytes');
    const modelDbSettingsPath = path.join(root, 'model.yml');
    await write('sources/main.yaml', 'main'); await write('sources/.hidden/nested/nested.yaml', 'nested');
    const request = { sourceRoots: [sources, path.join(sources, '.hidden')], compilerPath, modelDbSettingsPath,
        configuration: { profile: 'one', password: 'private fixture value' } };
    const artifact = async (prefix = '') => {
        await write('output/' + prefix + 'same.feature', '# language: en\nFeature: A\nScenario: B\n And Delay 1\n');
        await write('output/' + prefix + 'same.str', map);
    };
    return { root, sources, output, request, write, artifact };
}

test('disk capture includes complete recursive YAML inventory, model file and compiler without duplicate overlapping roots', async t => {
    const f = await fixture(t);
    await f.write('sources/attachment.txt', 'not compiler source'); await f.write('sources/other.yml', 'not compiler source');
    const before = await captureCompilerBuildInputs(f.request);
    assert.equal(before.sources.length, 2); assert.equal(before.inputs.files.length, 3);
    assert.ok(before.sources.some(source => source.uri === pathToFileURL(path.join(f.sources, '.hidden/nested/nested.yaml')).href));
    await f.write('model.yml', 'model');
    assert.notEqual((await captureCompilerBuildInputs(f.request)).inputs.digest, before.inputs.digest);
    await fs.rm(f.request.modelDbSettingsPath);
    assert.equal((await captureCompilerBuildInputs(f.request)).inputs.digest, before.inputs.digest);
    await f.write('sources/new.yaml', 'new');
    assert.notEqual((await captureCompilerBuildInputs(f.request)).inputs.digest, before.inputs.digest);
    await fs.rm(path.join(f.sources, 'new.yaml'));
    await f.write('compiler.epf', 'new compiler');
    assert.notEqual((await captureCompilerBuildInputs(f.request)).inputs.digest, before.inputs.digest);
});

test('input URI identity is supplied by the editor host, including Windows drive encoding', async t => {
    const f = await fixture(t);
    const captured = await captureCompilerBuildInputs({ ...f.request, uriForPath: file => 'file:///c%3A/project/' + path.basename(file) });
    assert.ok(captured.inputs.files.every(file => file.uri.startsWith('file:///c%3A/project/')));
    assert.ok(captured.sources.every(source => source.uri.startsWith('file:///c%3A/project/')));
});

test('publishing binds final postprocessed bytes and worker identity, and persists no raw configuration', async t => {
    const f = await fixture(t); await f.artifact('part-1/'); await f.artifact('part-2/');
    const before = await captureCompilerBuildInputs(f.request);
    await f.write('output/part-2/same.feature', '# language: en\nFeature: A\nScenario: B\n And Delay 2\n');
    const workers = [{ worker: 1, prefix: 'part-1' }, { worker: 2, prefix: 'part-2' }];
    const published = await publishCompilerBuildManifest(f.output, { before: before.inputs, after: before.inputs, workers, successful: true });
    assert.ok(published); assert.equal(published.artifacts.length, 2);
    assert.deepEqual(await readCompilerBuildManifest(f.output), published);
    const serialized = await fs.readFile(path.join(f.output, COMPILER_BUILD_MANIFEST_NAME), 'utf8');
    assert.ok(!serialized.includes('private fixture value')); assert.ok(!serialized.includes('compiler bytes'));
    const artifacts = await readCompilerBuildManifestArtifacts(f.output, published);
    assert.equal(verifyCompilerBuildManifest(published, before.inputs, artifacts.fingerprints), 'fresh');
    assert.ok(artifacts.contents.some(item => item.worker === 2 && item.featureContent.includes('Delay 2')));
    await f.write('output/part-2/same.str', map + ' ');
    assert.equal(verifyCompilerBuildManifest(published, before.inputs, (await readCompilerBuildManifestArtifacts(f.output, published)).fingerprints), 'artifactsChanged');
});

test('failed, changed, empty and incomplete builds remove previous certification and never leave temporary manifests', async t => {
    const f = await fixture(t); await f.artifact(); const before = (await captureCompilerBuildInputs(f.request)).inputs;
    const options = { before, after: before, workers: [{ worker: 1, prefix: '' }], successful: true };
    assert.ok(await publishCompilerBuildManifest(f.output, options));
    await invalidateCompilerBuildManifest(f.output);
    assert.equal(await readCompilerBuildManifest(f.output), undefined);
    assert.equal(await publishCompilerBuildManifest(f.output, { ...options, successful: false }), undefined);
    await f.write('sources/main.yaml', 'changed');
    assert.equal(await publishCompilerBuildManifest(f.output, { ...options, after: (await captureCompilerBuildInputs(f.request)).inputs }), undefined);
    await fs.rm(path.join(f.output, 'same.str'));
    await assert.rejects(publishCompilerBuildManifest(f.output, options));
    assert.equal(await readCompilerBuildManifest(f.output), undefined);
    assert.ok(!(await fs.readdir(f.output)).some(name => name.includes('.tmp')));
    await fs.rm(path.join(f.output, 'same.feature'));
    assert.equal(await publishCompilerBuildManifest(f.output, options), undefined);
});

test('input comparison must happen after temporarily isolated settings are restored', async t => {
    const f = await fixture(t); await f.artifact(); await f.write('sources/test.yaml', 'disabled test settings');
    const before = (await captureCompilerBuildInputs(f.request)).inputs;
    const setting = path.join(f.sources, 'test.yaml'); const temporary = path.join(f.root, 'temporary');
    await fs.rename(setting, temporary);
    const options = { before, after: (await captureCompilerBuildInputs(f.request)).inputs, workers: [{ worker: 1, prefix: '' }], successful: true };
    assert.equal(await publishCompilerBuildManifest(f.output, options), undefined);
    await fs.rename(temporary, setting);
    assert.ok(await publishCompilerBuildManifest(f.output, { ...options, after: (await captureCompilerBuildInputs(f.request)).inputs }));
});

test('unknown manifests, absent maps and invalid worker namespaces cannot certify execution', async t => {
    const f = await fixture(t); await f.artifact(); const before = (await captureCompilerBuildInputs(f.request)).inputs;
    await f.write('output/' + COMPILER_BUILD_MANIFEST_NAME, '{broken');
    assert.equal(await readCompilerBuildManifest(f.output), undefined);
    for (const prefix of ['..', '../outside', '/absolute', 'C:/outside', 'part\\one']) {
        await assert.rejects(publishCompilerBuildManifest(f.output, { before, after: before, workers: [{ worker: 1, prefix }], successful: true }));
    }
    const manifest = await publishCompilerBuildManifest(f.output, { before, after: before, workers: [{ worker: 1, prefix: '' }], successful: true });
    assert.ok(manifest);
    await fs.rm(path.join(f.output, 'same.str'));
    await assert.rejects(readCompilerBuildManifestArtifacts(f.output, manifest));
});

test('symlink inputs or artifact paths cannot silently escape the captured inventory', { skip: process.platform === 'win32' }, async t => {
    const f = await fixture(t); await f.artifact(); const before = (await captureCompilerBuildInputs(f.request)).inputs;
    const outside = await f.write('outside/other.yaml', 'outside');
    await fs.symlink(path.dirname(outside), path.join(f.sources, 'link'), 'dir');
    await assert.rejects(captureCompilerBuildInputs(f.request), /symbolic|symlink/i);
    await fs.rm(path.join(f.sources, 'link'));
    await fs.rm(path.join(f.output, 'same.str')); await fs.symlink(outside, path.join(f.output, 'same.str'));
    await assert.rejects(publishCompilerBuildManifest(f.output, { before, after: before, workers: [{ worker: 1, prefix: '' }], successful: true }), /symbolic|symlink/i);
});
