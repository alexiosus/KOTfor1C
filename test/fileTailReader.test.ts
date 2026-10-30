import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    isTransientFileReadError,
    readFileTail,
    readFileTailSync
} from '../src/fileTailReader';

test('reads only bytes appended after the previous length', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-tail-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'run.log');
    await fs.writeFile(filePath, 'first\nsecond\n');

    const result = await readFileTail(filePath, Buffer.byteLength('first\n'));

    assert.equal(result?.content.toString('utf8'), 'second\n');
    assert.equal(result?.currentLength, Buffer.byteLength('first\nsecond\n'));
    assert.equal(result?.wasTruncated, false);
});

test('restarts at byte zero when the file was truncated', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-tail-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'run.log');
    await fs.writeFile(filePath, 'new\n');

    const result = await readFileTail(filePath, 100);

    assert.equal(result?.content.toString('utf8'), 'new\n');
    assert.equal(result?.currentLength, 4);
    assert.equal(result?.wasTruncated, true);
});

test('returns null when the watched file does not exist', async () => {
    assert.equal(await readFileTail(path.join(os.tmpdir(), 'kot-missing-run.log'), 0), null);
});

test('shares one in-flight read for the same file and offset', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-tail-shared-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'run.log');
    await fs.writeFile(filePath, 'line\n');

    const first = readFileTail(filePath, 0);
    const second = readFileTail(filePath, 0);

    assert.equal(first, second);
    assert.equal((await first)?.content.toString('utf8'), 'line\n');
});

test('recognizes Windows sharing violations as transient live-log reads', () => {
    for (const code of ['EBUSY', 'EACCES', 'EPERM']) {
        assert.equal(isTransientFileReadError({ code }), true);
    }
    assert.equal(isTransientFileReadError({ code: 'EIO' }), false);
    assert.equal(isTransientFileReadError(new Error('unknown')), false);
});

test('synchronous tail reader reads only appended bytes', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-tail-sync-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'run.log');
    await fs.writeFile(filePath, 'old\nnew\n');

    const result = readFileTailSync(filePath, Buffer.byteLength('old\n'));

    assert.equal(result?.content.toString('utf8'), 'new\n');
    assert.equal(result?.currentLength, Buffer.byteLength('old\nnew\n'));
    assert.equal(result?.wasTruncated, false);
});

test('synchronous tail reader does not replay a file when offset equals its size', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-tail-sync-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'run.log');
    await fs.writeFile(filePath, 'old failure\n');
    const size = Buffer.byteLength('old failure\n');

    const result = readFileTailSync(filePath, size);

    assert.equal(result?.content.byteLength, 0);
    assert.equal(result?.currentLength, size);
    assert.equal(result?.wasTruncated, false);
});
