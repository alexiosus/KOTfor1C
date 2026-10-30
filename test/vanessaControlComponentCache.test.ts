import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { acquireMcpComponent } from '../src/vanessaControlComponentCache';

test('verified cache avoids downloads; corrupt cache is replaced only by a correctly hashed official artifact', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-mcp-cache-'));
    const payload = Buffer.from('pinned component'); const sha256 = createHash('sha256').update(payload).digest('hex');
    const component = { version: 'test', sha256, url: 'https://github.com/official/release/component.cfe' };
    let downloads = 0;
    const fetcher = (async () => { downloads++; return new Response(payload); }) as typeof fetch;
    try {
        const file = await acquireMcpComponent(root, component, fetcher);
        assert.deepEqual(await fs.readFile(file), payload);
        await acquireMcpComponent(root, component, fetcher); assert.equal(downloads, 1);
        await fs.writeFile(file, 'corrupt');
        await assert.rejects(acquireMcpComponent(root, component, (async () => new Response('wrong hash')) as typeof fetch), /checksum/i);
        assert.equal(await fs.readFile(file, 'utf8'), 'corrupt', 'failed download cannot become the cache');
        await acquireMcpComponent(root, component, fetcher); assert.equal(downloads, 2);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
