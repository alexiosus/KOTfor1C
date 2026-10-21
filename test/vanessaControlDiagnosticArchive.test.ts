import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { createVanessaDiagnosticArchive } from '../src/vanessaControlDiagnosticArchive';
test('a local diagnostics archive redacts text again and excludes screenshots unless explicitly selected', async () => {
    const report = { schemaVersion: 1 as const, createdAt: '2026-10-20T00:00:00Z', sections: [{ tool: 'get_test_results' as const, status: 'available' as const, text: 'Safe\npassword=private' }] };
    const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const textOnly = await JSZip.loadAsync(await createVanessaDiagnosticArchive(report, [image]));
    assert.ok(!Object.keys(textOnly.files).some(name => name.endsWith('.png')));
    assert.ok(!(await textOnly.file('report.json')!.async('string')).includes('private'));
    const withImage = await JSZip.loadAsync(await createVanessaDiagnosticArchive(report, [image], true));
    assert.deepEqual(await withImage.file('screenshot-1.png')!.async('nodebuffer'), image);
});
