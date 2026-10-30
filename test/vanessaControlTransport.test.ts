import assert from 'node:assert/strict';
import test from 'node:test';
import { VanessaControlHttpTransport } from '../src/vanessaControlTransport';

function server(options: { hang?: string; sse?: boolean; brokenSse?: boolean; fail?: boolean; pages?: boolean } = {}) {
    const requests: any[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
        if (init?.method === 'GET') { return new Response(null, { status: 405 }); }
        const request = JSON.parse(String(init?.body)); requests.push(request);
        if (options.hang === request.method) { return new Promise(() => {}); }
        if (request.id === undefined) { return new Response(null, { status: 202 }); }
        if (options.fail && request.method === 'tools/call') { throw new Error('server credential token=secret'); }
        let result: any;
        if (request.method === 'initialize') {
            result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Fixture', version: '1' } };
        } else if (request.method === 'tools/list') {
            const tool = { name: request.params?.cursor ? 'second' : 'first', inputSchema: { type: 'object', properties: {} } };
            result = { tools: [tool], ...(options.pages && !request.params?.cursor ? { nextCursor: 'next' } : {}) };
        } else {
            result = { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }] };
        }
        const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
        if ((options.sse || options.brokenSse) && request.method === 'tools/call') {
            const text = options.brokenSse ? 'data: {"jsonrpc":' : `event: message\ndata: ${body}\n\n`;
            const encoder = new TextEncoder();
            const stream = new ReadableStream({ start(controller) {
                controller.enqueue(encoder.encode(text.slice(0, 10)));
                controller.enqueue(encoder.encode(text.slice(10)));
                controller.close();
            } });
            return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
        }
        return new Response(body, { headers: { 'content-type': 'application/json' } });
    };
    return { fetcher, requests };
}

test('the official SDK negotiates MCP, lists all pages, and calls a tool over HTTP without running 1C', async t => {
    const s = server({ pages: true });
    const transport = new VanessaControlHttpTransport({ fetch: s.fetcher }); t.after(() => transport.dispose());
    assert.deepEqual(await transport.initialize('http://localhost:9876/mcp'), { name: 'Fixture', version: '1' });
    assert.deepEqual((await transport.listTools()).map(tool => tool.name), ['first', 'second']);
    const result = await transport.callTool('echo', { lineNumber: 12 });
    assert.equal((result.content[0] as any).text, '{"lineNumber":12}');
    assert.equal(s.requests.some(request => request.method === 'server/discover'), false);
    assert.equal(s.requests.filter(request => request.method === 'tools/call').length, 1);
});

test('the SDK accepts a split SSE response and never accepts a truncated stream as success', async t => {
    const good = new VanessaControlHttpTransport({ fetch: server({ sse: true }).fetcher }); t.after(() => good.dispose());
    await good.initialize('http://localhost:9876/mcp');
    assert.equal((await good.callTool('echo', { value: 'SSE' })).isError, undefined);
    const broken = new VanessaControlHttpTransport({ fetch: server({ brokenSse: true }).fetcher, timeoutMs: 30 }); t.after(() => broken.dispose());
    await broken.initialize('http://localhost:9876/mcp');
    await assert.rejects(broken.callTool('echo', {}));
});

test('timeouts cover the initialize handshake and tool requests even when fetch does not settle', async t => {
    for (const method of ['initialize', 'tools/call']) {
        const transport = new VanessaControlHttpTransport({ fetch: server({ hang: method }).fetcher, timeoutMs: 20 }); t.after(() => transport.dispose());
        if (method !== 'initialize') { await transport.initialize('http://localhost:9876/mcp'); }
        await assert.rejects(method === 'initialize' ? transport.initialize('http://localhost:9876/mcp') : transport.callTool('echo', {}),
            (error: any) => error.code === 'timeout');
    }
});

test('cancel and detach reject pending calls and late replies cannot restore an old connection', async t => {
    const transport = new VanessaControlHttpTransport({ fetch: server({ hang: 'tools/call' }).fetcher }); t.after(() => transport.dispose());
    await transport.initialize('http://localhost:9876/mcp');
    const controller = new AbortController();
    const pending = transport.callTool('echo', {}, controller.signal);
    const cancelled = assert.rejects(pending, (error: any) => error.code === 'cancelled');
    controller.abort(); await cancelled;
    const detached = assert.rejects(transport.callTool('echo', {}), (error: any) => error.code === 'disconnected');
    await transport.dispose(); await detached;
    await assert.rejects(transport.callTool('echo', {}), (error: any) => error.code === 'notConnected');
});

test('transport failures never expose credentials from a server error', async t => {
    const transport = new VanessaControlHttpTransport({ fetch: server({ fail: true }).fetcher }); t.after(() => transport.dispose());
    await transport.initialize('http://localhost:9876/mcp');
    await assert.rejects(transport.callTool('echo', {}), (error: any) => !String(error).includes('secret'));
});

test('readiness handshake has a short timeout independent of long-running scenario calls', async t => {
    const transport = new VanessaControlHttpTransport({ fetch: server({ hang: 'initialize' }).fetcher, timeoutMs: 2_000, initializeTimeoutMs: 20 });
    t.after(() => transport.dispose());
    const started = Date.now();
    await assert.rejects(transport.initialize('http://localhost:9876/mcp'), (error: any) => error.code === 'timeout');
    assert.ok(Date.now() - started < 1_000);
});

test('a late handshake from a replaced connection cannot replace or dispose the new connection', async t => {
    const s = server();
    let release!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    let oldId: unknown;
    const fetcher: typeof fetch = async (input, init) => {
        const request = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (first && request?.method === 'initialize') {
            first = false; oldId = request.id; entered();
            return new Promise(resolve => { release = resolve; });
        }
        return s.fetcher(input, init);
    };
    const transport = new VanessaControlHttpTransport({ fetch: fetcher }); t.after(() => transport.dispose());
    const old = assert.rejects(transport.initialize('http://localhost:9875/mcp'), (error: any) => error.code === 'disconnected');
    await started;
    assert.deepEqual(await transport.initialize('http://localhost:9876/mcp'), { name: 'Fixture', version: '1' });
    release(new Response(JSON.stringify({ jsonrpc: '2.0', id: oldId, result: {
        protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Old', version: '0' }
    } }), { headers: { 'content-type': 'application/json' } }));
    await old;
    assert.equal((await transport.callTool('echo', { value: 'new' }).then(result => result.content[0]) as any).text, '{"value":"new"}');
});

test('tool listing and execution are rejected until the handshake completes', async t => {
    const s = server();
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetcher: typeof fetch = async (input, init) => {
        if (init?.body && JSON.parse(String(init.body)).method === 'initialize') { entered(); await gate; }
        return s.fetcher(input, init);
    };
    const transport = new VanessaControlHttpTransport({ fetch: fetcher }); t.after(() => transport.dispose());
    const connecting = transport.initialize('http://localhost:9876/mcp');
    await started;
    try {
        const results = await Promise.allSettled([transport.listTools(), transport.callTool('echo', {})]);
        assert.deepEqual(results.map(result => result.status === 'rejected' ? result.reason.code : 'sent'), ['notConnected', 'notConnected']);
    } finally { release(); await connecting; }
});

test('legacy cancellation aborts only its HTTP POST and keeps the connection usable', async t => {
    const s = server();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const observed: { signal?: AbortSignal | null } = {};
    const fetcher: typeof fetch = async (input, init) => {
        const request = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (request?.method === 'tools/call' && request.params.name === 'longRun') {
            observed.signal = init?.signal; entered();
            return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        }
        return s.fetcher(input, init);
    };
    const transport = new VanessaControlHttpTransport({ fetch: fetcher }); t.after(() => transport.dispose());
    await transport.initialize('http://localhost:9876/mcp');
    const controller = new AbortController();
    const cancelled = assert.rejects(transport.callTool('longRun', {}, controller.signal), (error: any) => error.code === 'cancelled');
    await started;
    controller.abort(); await cancelled;
    assert.equal(observed.signal?.aborted, true);
    assert.equal((await transport.callTool('echo', { value: 'still-connected' }).then(result => result.content[0]) as any).text, '{"value":"still-connected"}');
    assert.equal(s.requests.some(request => request.method === 'notifications/cancelled'), true);
});

test('progress is routed by the SDK token and carries counts without executing a second request', async t => {
    const s = server();
    const fetcher: typeof fetch = async (input, init) => {
        const request = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (request?.method !== 'tools/call') { return s.fetcher(input, init); }
        const token = request.params._meta?.progressToken;
        const messages = [
            { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 3, message: 'business-value' } },
            { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'done' }] } }
        ];
        return new Response(messages.map(message => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    };
    const transport = new VanessaControlHttpTransport({ fetch: fetcher }); t.after(() => transport.dispose());
    await transport.initialize('http://localhost:9876/mcp');
    const progress: unknown[] = [];
    await transport.callTool('run_scenario', {}, undefined, value => progress.push(value));
    assert.deepEqual(progress, [{ completed: 1, total: 3 }]);
});

test('client lifecycle and explicit form analysis can wait beyond the short read deadline without retrying', async t => {
    for (const tool of ['manage_test_client', 'close_test_client', 'get_form_analysis']) {
        const fixture = server(); let entered!: () => void; let release!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const wire = new VanessaControlHttpTransport({ timeoutMs: 180_000, fetch: async (input, init) => {
            const message = init?.body ? JSON.parse(String(init.body)) : undefined;
            if (message?.method === 'tools/call') { entered(); await gate; }
            return fixture.fetcher(input, init);
        } });
        await wire.initialize('http://localhost:9876/mcp');
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let settled = false;
        const pending = wire.callTool(tool, { action: 'connect', profileName: 'owned' }).finally(() => { settled = true; });
        const observed = pending.catch(() => undefined);
        try {
            await started; t.mock.timers.tick(30_001); await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(settled, false, `${tool} timed out at the read deadline`);
            release(); await pending;
            assert.equal(fixture.requests.filter(request => request.method === 'tools/call').length, 1);
        } finally { release(); await observed; t.mock.timers.reset(); await wire.dispose(); }
    }
});
