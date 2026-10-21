import JSZip from 'jszip';
import { redactVanessaDiagnosticText, type VanessaDiagnosticReport } from './vanessaControlDiagnostics';

/** No upload or external paths; images need an explicit export choice because they cannot be text-redacted. */
export async function createVanessaDiagnosticArchive(report: VanessaDiagnosticReport, images: readonly Buffer[] = [], includeImages = false): Promise<Buffer> {
    const zip = new JSZip();
    const clean = { schemaVersion: report.schemaVersion, createdAt: report.createdAt,
        sections: report.sections.map(section => ({ tool: section.tool, status: section.status,
            ...(section.text === undefined ? {} : { text: redactVanessaDiagnosticText(section.text) }) })) };
    zip.file('report.json', JSON.stringify(clean, null, 2));
    zip.file('README.txt', 'KOT Vanessa MCP diagnostics. Explicit local snapshot, not a continuous trace.\n' +
        'Standard credential-bearing text lines and connection keys are omitted. Unknown tool replies do not prove successful execution.\n' +
        'Screenshots are included only when selected at export; image contents are not redacted.\n');
    if (includeImages) {
        if (images.reduce((total, image) => total + image.length, 0) > 64_000_000) { throw new Error('The selected screenshots exceed the diagnostic package size limit.'); }
        for (const [index, image] of images.entries()) {
            if (!image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) { throw new Error('Unsupported diagnostic screenshot.'); }
            zip.file(`screenshot-${index + 1}.png`, image);
        }
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
