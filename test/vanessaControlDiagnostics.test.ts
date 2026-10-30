import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { VanessaRuntimeDiagnostics, redactVanessaDiagnosticText, type VanessaDiagnosticPorts } from '../src/vanessaControlDiagnostics';
const reply = (text: string) => ({ content: [{ type: 'text', text }] });
test('diagnostics omit credential-bearing lines, connection keys, bearer tokens and encoded secrets', () => {
    const privateLines = ['Pwd="private";', '{"password":"private"}', 'Authorization: Bearer private', '/N User /P"private"',
        'https://user:private@host/path', 'https://host/?access_token=private', 'api_key=private', 'Пароль = "private"',
        '| Строка подключения | File=private; |', '| Дополнительные параметры | /privateflag private |', '%70%77%64=private'];
    const cleaned = redactVanessaDiagnosticText('Safe status\n' + privateLines.join('\n'));
    assert.ok(!cleaned.includes('private')); assert.match(cleaned, /Safe status/u);
});
test('diagnostics redact argv, CLI and environment credentials and multiline values', () => {
    for (const text of ['["/N","User","/P","private"]', '--password=private', '--password private',
        'OPENAI_API_KEY=private', 'MY_ACCESS_TOKEN=private', 'Password:\n  "private"',
        '"password":\n"private",\n"status": "Safe status"', 'password: |\n  private\n  more private\nstatus: Safe status']) {
        assert.ok(!redactVanessaDiagnosticText(text).includes('private'), text);
    }
    assert.match(redactVanessaDiagnosticText('password:\n  private\nstatus: Safe status'), /Safe status/u);
});
function setup() {
    let current = true; const calls: Array<[string, Record<string, unknown>]> = [];
    const ports: VanessaDiagnosticPorts = { isCurrent: () => current, supported: () => true,
        request: async (tool, args) => { calls.push([tool, args]); return reply('Own response\nPwd=private'); } };
    return { ports, runtime: new VanessaRuntimeDiagnostics(ports), calls, change: () => { current = false; } };
}
test('basic diagnostics are explicit, scrubbed, partial and never read logs or screenshots implicitly', async () => {
    const own = setup(); own.ports.supported = tool => tool !== 'get_environment_data';
    const report = await own.runtime.collect();
    assert.equal(report.sections.find(s => s.tool === 'get_environment_data')?.status, 'unavailable');
    assert.equal(report.sections.find(s => s.tool === 'get_test_results')?.status, 'available');
    assert.ok(!JSON.stringify(report).includes('private'));
    assert.deepEqual(own.calls.map(([tool]) => tool), ['get_vanessa_automation_state', 'manage_test_client_profiles', 'get_test_results']);
});
test('event-log reads are bounded and failures remain partial without exporting raw errors', async () => {
    const own = setup(); const request = own.ports.request;
    own.ports.request = async (tool, args, signal) => {
        if (tool === 'get_event_log_test_client') { throw new Error('private credentials'); }
        return request(tool, args, signal);
    };
    const report = await own.runtime.collect({ managerLog: true, clientLog: true });
    const args = own.calls.find(([tool]) => tool === 'get_event_log_manager')![1];
    assert.equal(args.limit, 100); assert.equal(args.scan_limit, 500); assert.equal(args.output_file, undefined);
    assert.equal(report.sections.at(-1)?.status, 'error'); assert.match(report.sections.at(-1)?.text ?? '', /VAExtension 1\.40/u);
    assert.ok(!JSON.stringify(report).includes('private'));
});
test('cancellation and session changes discard the diagnostic result instead of publishing old data', async () => {
    for (const cancel of [true, false]) {
        const own = setup(); const controller = new AbortController();
        own.ports.request = async () => { if (cancel) { controller.abort(); } else { own.change(); } return reply('stale'); };
        await assert.rejects(own.runtime.collect({}, controller.signal)); assert.equal(own.calls.length, 0);
    }
});
test('runtime search and syntax validation use separate negotiated tools and keep unknown formats as responses', async () => {
    const own = setup();
    assert.match(await own.runtime.search('Delay'), /Own response/u);
    assert.deepEqual(own.calls[0], ['search_for_steps_by_keywords', { search_name: 'Delay', limit: 50 }]);
    await own.runtime.checkSyntax('C:\\own.feature'); assert.equal(own.calls[1][0], 'check_syntax');
    await assert.rejects(own.runtime.checkSyntax('C:\\own.yaml')); await assert.rejects(own.runtime.search(''));
    own.ports.supported = () => false; await assert.rejects(own.runtime.search('Delay'));
});
test('the .45 syntax result unwraps its message envelope without treating the text as a verified pass', async () => {
    const own = setup();
    own.ports.request = async () => reply(JSON.stringify({ message: '# Проверка синтаксиса Gherkin\n- Синтаксис корректен: да', completedAt: 'own' }));
    assert.equal(await own.runtime.checkSyntax('C:\\own.feature'), '# Проверка синтаксиса Gherkin\n- Синтаксис корректен: да');
});

test('screenshots accept one bounded PNG only for a freshly selected connected-client window', async () => {
    const own = setup();
    const clients = fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/clients-connected.live.ru.md', 'utf8');
    const image = Buffer.from('89504e470d0a1a0a00000000', 'hex'); let changed = false;
    own.ports.request = async tool => tool === 'manage_test_client_profiles' ? reply(clients)
        : tool === 'get_window_list_os' ? reply('Для снятия скриншотов найдено 1 окон:\n  -' + (changed ? 'Other' : 'Own'))
            : { content: [{ type: 'text', text: 'Own screenshot' }, { type: 'image', mimeType: 'image/png', data: image.toString('base64') }] };
    const windows = await own.runtime.windows(); assert.deepEqual(windows.titles, ['Own']);
    const shot = await own.runtime.screenshot(windows, 'Own'); assert.deepEqual(shot, image);
    changed = true; await assert.rejects(own.runtime.screenshot(windows, 'Own'));
});
test('screenshot selection rejects titles that are ambiguous under the runtime case-insensitive match', async () => {
    const own = setup(); const clients = fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/clients-connected.live.ru.md', 'utf8');
    own.ports.request = async tool => reply(tool === 'manage_test_client_profiles' ? clients : 'Для снятия скриншотов найдено 2 окон:\n  -OWN\n  -own');
    await assert.rejects(own.runtime.windows());
});
test('PNG validation rejects malformed data and handles normal large replies without reading remote paths', async () => {
    const own = setup(); const clients = fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/clients-connected.live.ru.md', 'utf8');
    let data = 'not base64';
    own.ports.request = async tool => tool === 'manage_test_client_profiles' ? reply(clients)
        : tool === 'get_window_list_os' ? reply('Для снятия скриншотов найдено 1 окон:\n  -Own')
            : { content: [{ type: 'image', mimeType: 'image/png', data }] };
    const windows = await own.runtime.windows();
    await assert.rejects(own.runtime.screenshot(windows, 'Own'));
    data = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(1_000_000)]).toString('base64');
    assert.equal((await own.runtime.screenshot(windows, 'Own')).length, 1_000_008);
});
test('a .45 file-only screenshot can read only the exact owned path supplied in its request', async () => {
    const own = setup(); const clients = fs.readFileSync('test/fixtures/vanessa-control/1.2.043.45/clients-connected.live.ru.md', 'utf8');
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex'); let other = false; const target = 'C:\\own-temp\\capture.png';
    own.ports.screenshotFile = async capture => { const inline = await capture(target); return inline ?? png; };
    own.ports.request = async (tool, args) => tool === 'manage_test_client_profiles' ? reply(clients)
        : tool === 'get_window_list_os' ? reply('Для снятия скриншотов найдено 1 окон:\n  -Own')
            : (assert.equal(args.file_name, target), reply('# Скриншот клиента тестирования\nСкриншот окна записан в файл: ' + (other ? 'C:\\unrelated.png' : target)));
    const windows = await own.runtime.windows(); assert.deepEqual(await own.runtime.screenshot(windows, 'Own'), png);
    other = true; await assert.rejects(own.runtime.screenshot(windows, 'Own'));
});
