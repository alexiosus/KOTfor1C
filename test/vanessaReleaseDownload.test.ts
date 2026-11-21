import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import JSZip = require('jszip');
import { installVanessaRelease, listVanessaReleasePage, parseVanessaReleases, type VanessaRelease } from '../src/vanessaReleaseDownload';

const tag = '1.2.043.47';
const url = `https://github.com/Pr-Mex/vanessa-automation/releases/download/${tag}/vanessa-automation.${tag}.zip`;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const signal = () => new AbortController().signal;
async function fixture(t: test.TestContext, extras: Record<string, string> = {}) {
    const project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kot-va-download-')));
    t.after(() => fs.rm(project, { recursive: true, force: true }));
    const archive = new JSZip();
    for (const [file, content] of Object.entries({ 'vanessa-automation.epf': 'EPF', 'locales/Steps.epf': 'Steps', 'docs/Changelog.md': `# ${tag}`,
        'licenses/third-party.txt': 'Third party notice', ...extras })) { archive.file(`vanessa-automation/${file}`, content); }
    const bytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const release: VanessaRelease = { version: tag, tag, assetId: 100, url, size: bytes.length, sha256: digest(bytes) };
    const requests: string[] = []; const progress: string[] = [];
    const fetcher: typeof fetch = async input => {
        requests.push(String(input));
        return new Response(String(input) === url ? new Uint8Array(bytes) : 'BSD 3-Clause License\nCopyright notice\nDisclaimer');
    };
    return { project, bytes, release, fetcher, requests, progress,
        install: (options: { signal?: AbortSignal; fetch?: typeof fetch } = {}) => installVanessaRelease(project, release,
            { signal: options.signal ?? signal(), fetch: options.fetch ?? fetcher, progress: value => progress.push(value.phase) }) };
}

test('release selection accepts only uploaded full distributions from the official repository', async () => {
    const asset = { id: 100, state: 'uploaded', name: `vanessa-automation.${tag}.zip`, browser_download_url: url, size: 500, digest: `sha256:${'a'.repeat(64)}` };
    const release = { tag_name: tag, draft: false, prerelease: false, assets: [asset] };
    assert.equal(parseVanessaReleases([release])[0].sha256, 'a'.repeat(64));
    for (const changed of [{ draft: true }, { prerelease: true }, { tag_name: '../outside' }, { assets: [{ ...asset, name: `vanessa-automation-single.${tag}.zip` }] },
        { assets: [{ ...asset, browser_download_url: 'https://example.invalid/asset.zip' }] }, { assets: [{ ...asset, digest: 'sha256:invalid' }] }]) {
        assert.deepEqual(parseVanessaReleases([{ ...release, ...changed }]), []);
    }
    const calls: string[] = [];
    const result = await listVanessaReleasePage(2, signal(), async input => { calls.push(String(input)); return Response.json([release]); });
    assert.equal(result.releases[0].version, tag); assert.equal(result.more, false);
    assert.match(calls[0], /api\.github\.com\/repos\/Pr-Mex\/vanessa-automation\/releases\?per_page=100&page=2$/u);
});

test('a verified full release retains third-party notices and adds the exact tagged main license', async t => {
    const h = await fixture(t); const epf = await h.install();
    assert.equal(epf, path.join(h.project, 'tools', 'vanessa', tag, 'vanessa-automation.epf'));
    assert.equal(await fs.readFile(path.join(path.dirname(epf), 'licenses/third-party.txt'), 'utf8'), 'Third party notice');
    assert.match(await fs.readFile(path.join(path.dirname(epf), 'LICENSE'), 'utf8'), /BSD 3-Clause/u);
    assert.deepEqual(h.requests, [url, `https://raw.githubusercontent.com/Pr-Mex/vanessa-automation/${tag}/LICENSE`]);
    assert.ok(h.progress.includes('download')); assert.ok(h.progress.includes('extract')); assert.ok(h.progress.includes('license'));
    assert.equal(await h.install(), epf); assert.equal(h.requests.length, 2, 'a verified installed version does not download again');
    assert.deepEqual(await fs.readdir(path.dirname(path.dirname(epf))), [tag]);
});

test('archive notices are preserved and an existing or changed distribution is never overwritten', async t => {
    const h = await fixture(t, { LICENSE: 'Original upstream license' }); const epf = await h.install();
    assert.equal(h.requests.length, 1); assert.equal(await fs.readFile(path.join(path.dirname(epf), 'LICENSE'), 'utf8'), 'Original upstream license');
    await fs.writeFile(epf, 'Custom build');
    await assert.rejects(h.install(), /already exists/u);
    assert.equal(await fs.readFile(epf, 'utf8'), 'Custom build');
    const another = await fixture(t); const target = path.join(another.project, 'tools', 'vanessa', tag);
    await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'mine.txt'), 'keep');
    await assert.rejects(another.install(), /already exists/u); assert.equal(another.requests.length, 0);
});

test('checksum failures, unsafe paths and an unavailable license leave no partial installation', async t => {
    for (const failure of ['checksum', 'path', 'license'] as const) {
        const h = await fixture(t, failure === 'path' ? { '../escape.txt': 'not allowed' } : {});
        if (failure === 'checksum') { (h.release as { sha256: string }).sha256 = '0'.repeat(64); }
        await assert.rejects(h.install({ fetch: failure === 'license' ? async input => String(input) === url ? new Response(new Uint8Array(h.bytes)) : new Response('', { status: 404 }) : undefined }));
        assert.deepEqual(await fs.readdir(path.join(h.project, 'tools/vanessa')), [], failure);
        await assert.rejects(fs.stat(path.join(h.project, 'escape.txt')));
    }
});

test('cancelling during the archive transfer cleans its temporary directory', async t => {
    const h = await fixture(t); const cancellation = new AbortController();
    const fetcher: typeof fetch = async () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(h.bytes)); cancellation.abort(); controller.close();
    } }));
    await assert.rejects(h.install({ signal: cancellation.signal, fetch: fetcher }));
    assert.deepEqual(await fs.readdir(path.join(h.project, 'tools/vanessa')), []);
});

test('a destination symlink cannot redirect a download outside the project', async t => {
    const h = await fixture(t); const external = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-va-external-'));
    t.after(() => fs.rm(external, { recursive: true, force: true }));
    await fs.symlink(external, path.join(h.project, 'tools'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(h.install(), /inside the project/u); assert.deepEqual(await fs.readdir(external), []); assert.equal(h.requests.length, 0);
});
