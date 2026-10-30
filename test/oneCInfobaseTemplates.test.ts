import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverInfobaseTemplates, parseTemplateLocations, templateCreationArguments } from '../src/oneCInfobaseTemplates';

test('installed template manifests expose empty and demo variants with names and versions', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-tmplts-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const version = path.join(root, 'Vendor/App/1_2_3'); await fs.mkdir(version, { recursive: true });
    await fs.writeFile(path.join(version, '1cv8.mft'), 'Vendor=Vendor\nName=App\nVersion=1.2.3\n[Config1]\nCatalog=Vendor/App\nSource=1cv8.cf\n[Config2]\nCatalog=Vendor/App demo\nSource=1cv8.dt\n[Config3]\nCatalog=Unavailable\nSource=missing.cf\n[Config4]\nCatalog=Outside\nSource=../../../../outside.cf\n');
    await fs.writeFile(path.join(version, '1cv8.cf'), 'synthetic'); await fs.writeFile(path.join(version, '1cv8.dt'), 'synthetic');
    const found = await discoverInfobaseTemplates([root, root]);
    assert.deepEqual(found.map(item => [item.name, item.kind, item.version]).sort((a, b) => a[1].localeCompare(b[1])), [['Vendor/App', 'configuration', '1.2.3'], ['Vendor/App demo', 'demo', '1.2.3']]);
    assert.equal(found.every(item => item.filePath.startsWith(version)), true);
    assert.deepEqual(templateCreationArguments('File="C:\\Test";', found[0].filePath), ['CREATEINFOBASE', 'File="C:\\Test";', '/UseTemplate', found[0].filePath]);
});

test('launcher template locations support multiple entries, quotes and comments', () => {
    assert.deepEqual(parseTemplateLocations('ConfigurationTemplatesLocation="C:\\One"\n#comment\nConfigurationTemplatesLocation=\\\\server\\tmplts\n'), ['C:\\One', '\\\\server\\tmplts']);
});

test('template variants cannot escape the installed version through a linked directory', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-tmplts-link-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const version = path.join(root, 'version'); const outside = path.join(root, 'outside');
    await fs.mkdir(version); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'foreign.cf'), 'synthetic');
    await fs.symlink(outside, path.join(version, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(version, '1cv8.mft'), '[Config1]\nSource=linked/foreign.cf\n');
    assert.deepEqual(await discoverInfobaseTemplates([version]), []);
});
