import { assertProjectFormat3, projectFormatRoot, projectFormat } from './projectFormat';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';

export type SpprScenarioFormat = 'legacy' | 'native';
export interface NativeSpprScenario { readonly metadata: string; readonly script: string }

function validateMetadata(source: string): void {
    const yaml = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
    if (yaml.errors.length || yaml.get('ТипФайла') !== 'Сценарий' || !yaml.has('ДанныеСценария') || yaml.has('ТекстСценария')) {
        throw new Error('Expected unambiguous SPPR scenario metadata without an embedded script.');
    }
    if (!source.endsWith('\n')) { throw new Error('SPPR metadata must end with a newline for lossless conversion.'); }
}

/** Remove only the SPPR literal wrapper. Metadata, script EOLs and whitespace remain untouched. */
export function splitLegacySpprScenario(source: string): NativeSpprScenario {
    const markers = [...source.matchAll(/^ТекстСценария: \|(\r?\n)/gmu)];
    if (markers.length !== 1) { throw new Error('Conversion requires one terminal SPPR ТекстСценария: | block.'); }
    const marker = markers[0];
    const metadata = source.slice(0, marker.index);
    validateMetadata(metadata);
    const body = source.slice(marker.index + marker[0].length);
    const script = body.replace(/[^\r\n]+/gu, line => {
        if (line.trim() && !line.startsWith('    ')) { throw new Error('Script lines must use the SPPR four-space wrapper; conversion would be ambiguous.'); }
        return line.slice(4);
    });
    return { metadata, script };
}

/** SPPR reads the exact | marker; do not normalize, compile or expand the script. */
export function joinNativeSpprScenario(metadata: string, script: string): string {
    validateMetadata(metadata);
    const newline = metadata.includes('\r\n') ? '\r\n' : '\n';
    // Empty physical lines need no indentation, matching SPPR's own exported literal blocks.
    return `${metadata}ТекстСценария: |${newline}${script.replace(/[^\r\n]+/gu, line => `    ${line}`)}`;
}

async function readUtf8File(file: string): Promise<Buffer> {
    if (!(await fs.lstat(file)).isFile()) { throw new Error(`Conversion requires regular files: ${file}`); }
    const bytes = await fs.readFile(file);
    if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) { throw new Error(`Invalid UTF-8: ${file}`); }
    return bytes;
}

async function assertAbsent(file: string): Promise<void> {
    try { await fs.lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; } throw error; }
    throw new Error(`Conversion destination already exists: ${file}`);
}

/** Exclusive destination writes plus snapshots and rollback keep partial conversions recoverable. */
export async function convertSpprScenarioFiles(
    sourcePath: string,
    targetFormat: SpprScenarioFormat,
    assertSaved?: () => void | Promise<void>
): Promise<string> {
    const directory = path.dirname(sourcePath);
    const name = path.basename(sourcePath);
    if (!['scen.yaml', 'meta.yaml', 'scen.feature'].includes(name)) { throw new Error('Select scen.yaml, meta.yaml or scen.feature.'); }
    const sourceFormat = name === 'scen.yaml' ? 'legacy' : 'native';
    const owner = projectFormatRoot(directory);
    assertProjectFormat3(owner);
    const formatToken = projectFormat(owner).token;
    if (sourceFormat === targetFormat) { return path.join(directory, targetFormat === 'native' ? 'meta.yaml' : 'scen.yaml'); }
    const lock = path.join(directory, '.kot-format.lock');
    await fs.mkdir(lock);
    const originals = new Map<string, Buffer>();
    const outputs = new Map<string, Buffer>();
    const created: string[] = [];
    const moved: Array<{ source: string; backup: string }> = [];
    let committed = false;
    try {
        assertProjectFormat3(owner, formatToken);
        await assertSaved?.();
        const read = async (file: string) => {
            const bytes = await readUtf8File(file); originals.set(file, bytes); return bytes.toString('utf8');
        };
        const sourceDescriptor = path.join(directory, sourceFormat === 'legacy' ? 'scen.yaml' : 'meta.yaml');
        const targetDescriptor = path.join(directory, targetFormat === 'legacy' ? 'scen.yaml' : 'meta.yaml');
        if (sourceFormat === 'legacy') {
            const native = splitLegacySpprScenario(await read(sourceDescriptor));
            outputs.set(targetDescriptor, Buffer.from(native.metadata));
            outputs.set(path.join(directory, 'scen.feature'), Buffer.from(native.script));
        } else {
            const metadata = await read(sourceDescriptor);
            const script = await read(path.join(directory, 'scen.feature'));
            outputs.set(targetDescriptor, Buffer.from(joinNativeSpprScenario(metadata, script)));
        }
        const sidecar = `${sourceDescriptor}.kot.yml`;
        try { outputs.set(`${targetDescriptor}.kot.yml`, Buffer.from(await read(sidecar))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        // A stale sidecar is also a conflict even when the source has no sidecar.
        await assertAbsent(`${targetDescriptor}.kot.yml`);
        for (const destination of outputs.keys()) { await assertAbsent(destination); }
        assertProjectFormat3(owner, formatToken);
        for (const [destination, bytes] of outputs) {
            const handle = await fs.open(destination, 'wx'); created.push(destination);
            try { await handle.writeFile(bytes); } finally { await handle.close(); }
        }
        assertProjectFormat3(owner, formatToken);
        await assertSaved?.();
        for (const [file, bytes] of originals) {
            if (!(await fs.readFile(file)).equals(bytes)) { throw new Error(`Source changed during conversion: ${file}`); }
        }
        for (const [file, bytes] of outputs) {
            if (!(await fs.readFile(file)).equals(bytes)) { throw new Error(`Destination changed during conversion: ${file}`); }
        }
        assertProjectFormat3(owner, formatToken);
        for (const source of originals.keys()) {
            const backup = path.join(directory, `.kot-format-${randomUUID()}.backup`);
            await fs.rename(source, backup); moved.push({ source, backup });
        }
        committed = true;
        return targetDescriptor;
    } finally {
        try {
            if (!committed) {
                // Never overwrite a concurrent writer. Keep a backup if restoration cannot be safe.
                for (const { source, backup } of [...moved].reverse()) {
                    await assertAbsent(source); await fs.rename(backup, source);
                }
                for (const file of created) {
                    const current = await fs.readFile(file).catch(() => undefined);
                    const expected = outputs.get(file)!;
                    if (current && current.length <= expected.length && current.equals(expected.subarray(0, current.length))) { await fs.unlink(file); }
                }
            } else {
                for (const { backup } of moved) {
                    await fs.unlink(backup).catch(error => console.warn(`[SPPR] Retained conversion backup ${backup}:`, error));
                }
            }
        } finally { await fs.rmdir(lock); }
    }
}


/** Migration is scoped to the legacy compiler source, never arbitrary YAML or native metadata. */
export function shouldAutoMigrateScenario(fileName: string, text: string, enabled: boolean): boolean {
    return enabled && fileName.split(/[\\/]/u).at(-1) === 'scen.yaml'
        && /^\uFEFF?ТипФайла:[ \t]*["']?Сценарий["']?[ \t]*\r?$/mu.test(text)
        && /^ТекстСценария:[ \t]*\|/mu.test(text);
}
