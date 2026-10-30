import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPreparedFileWrites } from '../src/preparedFileWrites';

test('prepared writes restore all attempted files after a later write fails', async () => {
    const files = new Map([
        ['first', 'original first'],
        ['second', 'original second']
    ]);
    let failed = false;
    const write = async (key: string, content: string): Promise<void> => {
        files.set(key, content);
        if (key === 'second' && content === 'updated second' && !failed) {
            failed = true;
            throw new Error('disk write failed');
        }
    };

    await assert.rejects(
        applyPreparedFileWrites([
            { key: 'first', before: 'original first', after: 'updated first' },
            { key: 'second', before: 'original second', after: 'updated second' }
        ], write),
        /disk write failed/
    );
    assert.deepEqual([...files], [
        ['first', 'original first'],
        ['second', 'original second']
    ]);
});
