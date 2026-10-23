import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { findManagedVanessaRunLog } from '../src/vanessaControlRunLog';

test('reconnect recovers each manager log from its own private startup JSON, before the first feature writes it', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-mcp-log-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const port of [9876, 9877]) {
        const parametersPath = path.join(root, 'debug-params', `session-${port}`, 'VAParams.json');
        const log = path.join(root, 'logs', `vanessa-mcp-${port}.log`);
        await fs.mkdir(path.dirname(parametersPath), { recursive: true });
        await fs.writeFile(parametersPath, JSON.stringify({ logtotext: true, logstepstotext: true, textlogname: log, Password: 'never expose' }));
        const endpoint = `http://127.0.0.1:${port}/mcp`;
        assert.equal(await findManagedVanessaRunLog(endpoint, root, async value => {
            assert.equal(value, endpoint); return { parametersPath, startedAt: Date.now() + 1000 };
        }), log);
    }
});

test('unverified external or edited settings and disabled logging do not supply a guessed session log', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-mcp-log-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const parametersPath = path.join(root, 'debug-params', 'own', 'VAParams.json');
    await fs.mkdir(path.dirname(parametersPath), { recursive: true });
    const enabled = { ДелатьЛогВыполненияСценариевВТекстовыйФайл: true, ВыводитьВЛогВыполнениеШагов: true,
        ИмяФайлаЛогВыполненияСценариев: path.join(root, 'mcp-old.log') };
    await fs.writeFile(parametersPath, JSON.stringify(enabled));
    const lookup = async () => ({ parametersPath, startedAt: Date.now() + 1000 });
    assert.equal(await findManagedVanessaRunLog('http://127.0.0.1:9876/mcp', root, lookup), enabled.ИмяФайлаЛогВыполненияСценариев);
    assert.equal(await findManagedVanessaRunLog('', root, async () => undefined), undefined);
    assert.equal(await findManagedVanessaRunLog('', root, async () => ({ parametersPath, startedAt: 1 })), undefined);
    assert.equal(await findManagedVanessaRunLog('', path.join(root, 'another-project'), lookup), undefined);
    await fs.writeFile(parametersPath, JSON.stringify({ ...enabled, ВыводитьВЛогВыполнениеШагов: false }));
    assert.equal(await findManagedVanessaRunLog('', root, lookup), undefined);
    await fs.writeFile(parametersPath, JSON.stringify({ ...enabled, ИмяФайлаЛогВыполненияСценариев: path.join(os.tmpdir(), 'unrelated.log') }));
    assert.equal(await findManagedVanessaRunLog('', root, lookup), undefined);
});
