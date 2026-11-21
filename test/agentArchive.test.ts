import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import JSZip from 'jszip';
import { extractAgentArchive, agentArchiveName } from '../src/agentArchive';
import { agentContains, agentHash } from '../src/agentWorkspace';

async function fixture(t: test.TestContext, data: Buffer) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-agent-zip-'));
    t.after(async () => { assert.ok(agentContains(os.tmpdir(), root)); await fs.rm(root, { recursive: true, force: true }); });
    const archive = path.join(root, 'failure.zip'); await fs.writeFile(archive, data);
    return { root, archive, imports: path.join(root, 'imports') };
}
test('CI import extracts logs and DT payloads with validated checksums', async t => {
    const zip = new JSZip(); const data = Buffer.alloc(2 * 1024 * 1024, 27);
    zip.file('logs/run.log', 'step 3 failed'); zip.file('initial.dt', data);
    const { archive, imports } = await fixture(t, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    const result = await extractAgentArchive(archive, imports);
    assert.equal(await fs.readFile(path.join(result.directory, 'logs/run.log'), 'utf8'), 'step 3 failed');
    assert.equal(result.files.find(file => file.path === 'initial.dt')?.sha256, agentHash(data));
});
test('unsafe names and link entries are rejected before extraction', async t => {
    for (const name of ['../outside', 'a/../../outside', 'C:/outside', '/outside', 'a\\..\\outside', 'CON.txt', 'a. /x']) { assert.throws(() => agentArchiveName(name)); }
    const zip = new JSZip(); zip.file('link', '../outside', { unixPermissions: 0o120777 });
    const { archive, imports } = await fixture(t, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
    await assert.rejects(extractAgentArchive(archive, imports), /links/);
});
test('corrupt payload CRC removes only the owned extraction directory', async t => {
    const zip = new JSZip(); zip.file('run.log', 'failure'); const data = await zip.generateAsync({ type: 'nodebuffer' });
    const central = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); data.writeUInt32LE(123, central + 16);
    const { root, archive, imports } = await fixture(t, data); const marker = path.join(root, 'keep'); await fs.writeFile(marker, 'safe');
    await assert.rejects(extractAgentArchive(archive, imports), /checksum/); assert.equal(await fs.readFile(marker, 'utf8'), 'safe');
    assert.deepEqual(await fs.readdir(imports), []);
});
test('uncompressed import budget is checked before destination files are created', async t => {
    const zip = new JSZip(); zip.file('large.dt', Buffer.alloc(8192));
    const { archive, imports } = await fixture(t, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    await assert.rejects(extractAgentArchive(archive, imports, { bytes: 4096 }), /limits/);
    await assert.rejects(fs.stat(imports), { code: 'ENOENT' });
});
test('ZIP64 central directory and per-entry sizes are supported', async t => {
    const zip = new JSZip(); zip.file('base.dt', 'example'); const data = await zip.generateAsync({ type: 'nodebuffer' });
    const end = data.length - 22; const offset = data.readUInt32LE(end + 16); const central = Buffer.from(data.subarray(offset, end));
    const nameLength = central.readUInt16LE(28); const size = central.readUInt32LE(24); const compressed = central.readUInt32LE(20); const localOffset = central.readUInt32LE(42);
    const extra = Buffer.alloc(28); extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2); extra.writeBigUInt64LE(BigInt(size), 4); extra.writeBigUInt64LE(BigInt(compressed), 12); extra.writeBigUInt64LE(BigInt(localOffset), 20);
    central.writeUInt32LE(0xffffffff, 20); central.writeUInt32LE(0xffffffff, 24); central.writeUInt32LE(0xffffffff, 42); central.writeUInt16LE(28, 30);
    const expanded = Buffer.concat([central.subarray(0, 46 + nameLength), extra, central.subarray(46 + nameLength)]);
    const record = Buffer.alloc(56); record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4); record.writeBigUInt64LE(1n, 24); record.writeBigUInt64LE(1n, 32);
    record.writeBigUInt64LE(BigInt(expanded.length), 40); record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(offset + expanded.length), 8); locator.writeUInt32LE(1, 16);
    const footer = Buffer.from(data.subarray(end)); footer.writeUInt16LE(65535, 8); footer.writeUInt16LE(65535, 10); footer.writeUInt32LE(0xffffffff, 12); footer.writeUInt32LE(0xffffffff, 16);
    const { archive, imports } = await fixture(t, Buffer.concat([data.subarray(0, offset), expanded, record, locator, footer]));
    const result = await extractAgentArchive(archive, imports); assert.equal(await fs.readFile(path.join(result.directory, 'base.dt'), 'utf8'), 'example');
});
