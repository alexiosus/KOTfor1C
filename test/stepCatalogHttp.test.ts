import assert from 'node:assert/strict';
import test from 'node:test';
import {
    BoundedResponseAccumulator,
    resolveCatalogRedirect
} from '../src/stepCatalogHttp';

test('redirect policy resolves relative HTTPS locations', () => {
    const redirected = resolveCatalogRedirect(
        new URL('https://catalog.example/releases/index.json'),
        '../current/index.json'
    );
    assert.equal(redirected.toString(), 'https://catalog.example/current/index.json');
});

test('redirect policy rejects an HTTPS to HTTP downgrade', () => {
    assert.throws(
        () => resolveCatalogRedirect(
            new URL('https://catalog.example/index.json'),
            'http://catalog.example/index.json'
        ),
        /HTTPS/
    );
});

test('redirect policy rejects a missing Location header', () => {
    assert.throws(
        () => resolveCatalogRedirect(new URL('https://catalog.example/index.json'), undefined),
        /Location/
    );
});

test('response accumulator returns all chunks within the configured byte limit', () => {
    const accumulator = new BoundedResponseAccumulator(5);
    accumulator.append(Buffer.from('12'));
    accumulator.append(Buffer.from('345'));
    assert.deepEqual(accumulator.toUint8Array(), Buffer.from('12345'));
});

test('response accumulator aborts after the configured byte limit', () => {
    const accumulator = new BoundedResponseAccumulator(4);
    accumulator.append(Buffer.from('1234'));
    assert.throws(() => accumulator.append(Buffer.from('5')), /maximum size/);
});

test('response accumulator rejects invalid size limits', () => {
    assert.throws(() => new BoundedResponseAccumulator(0), /positive integer/);
});
