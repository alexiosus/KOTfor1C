import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverVanessaControlEndpoints, parseLocalOneCListeningPorts } from '../src/vanessaControlDiscovery';

test('discovery inspects only bounded local known/1C ports and returns verified Vanessa endpoints', async () => {
    const inspected: string[] = [];
    const result = await discoverVanessaControlEndpoints({ saved: ['http://127.0.0.1:1234/mcp', 'https://example.org/mcp', 'http://user:pwd@localhost:2/mcp'],
        ports: [1234, 6000, 7000, -1, 65536, 1.5],
        inspect: async endpoint => { inspected.push(endpoint); if (endpoint.includes(':7000/')) { throw new Error('unrelated server'); } return endpoint.includes(':6000/'); }
    }, new AbortController().signal);
    assert.deepEqual(result, ['http://127.0.0.1:6000/mcp']);
    assert.deepEqual(inspected.sort(), ['http://127.0.0.1:1234/mcp', 'http://127.0.0.1:6000/mcp', 'http://127.0.0.1:7000/mcp', 'http://127.0.0.1:9876/mcp'].sort());
});

test('multiple live sessions remain separate; cancellation rejects late discovery and concurrency is bounded', async () => {
    let active = 0; let peak = 0;
    const result = await discoverVanessaControlEndpoints({ saved: [], ports: [1111, 2222, 3333, 4444, 5555], inspect: async endpoint => {
        active++; peak = Math.max(peak, active); await new Promise<void>(resolve => setImmediate(resolve)); active--;
        return endpoint.includes(':1111/') || endpoint.includes(':2222/');
    } }, new AbortController().signal);
    assert.deepEqual(result, ['http://127.0.0.1:1111/mcp', 'http://127.0.0.1:2222/mcp']); assert.ok(peak <= 4);
    const controller = new AbortController();
    await assert.rejects(discoverVanessaControlEndpoints({ saved: [], ports: [], inspect: async () => { controller.abort(); return true; } }, controller.signal), { name: 'AbortError' });
});

test('listening port output contains numbers only and never treats process output as endpoints', () => {
    assert.deepEqual(parseLocalOneCListeningPorts('9876\r\n 6000 \r\n9876\r\nPwd=secret\r\nhttp://example.org/mcp\r\n0\r\n65536\r\n'), [9876, 6000]);
});
