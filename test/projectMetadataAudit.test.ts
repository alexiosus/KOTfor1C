import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { auditMetadataReferences } from '../src/projectMetadataAudit';
test('read-only conflict audit reports dangling groups, duplicate UIDs and test codes', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-audit-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    execFileSync('git', ['init', root], { stdio: 'ignore' });
    await fs.mkdir(path.join(root, '.kot/groups'), { recursive: true });
    await fs.writeFile(path.join(root, '.kot/groups/smoke.yml'), 'version: 1\nid: smoke\nname: Smoke\nsections: [main]\n');
    for (const name of ['a', 'b']) {
        await fs.mkdir(path.join(root, name));
        await fs.writeFile(path.join(root, name, 'meta.yaml'), 'ТипФайла: Сценарий\nДанныеСценария:\n    Код: 100\n');
        await fs.writeFile(path.join(root, name, 'meta.yaml.kot.yml'), 'version: 2\nidentity:\n    kind: scenario\n    uid: same\nmetadata:\n    groupId: missing\n');
    }
    const result = await auditMetadataReferences(root);
    assert.ok(result.some(value => value.includes('Unknown group missing')));
    assert.ok(result.some(value => value.includes('Duplicate metadata UID same')));
    assert.ok(result.some(value => value.includes('Duplicate test code 100')));
    assert.equal(execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' }), '');
});
