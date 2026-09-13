import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readFileTail } from '../src/fileTailReader';

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
