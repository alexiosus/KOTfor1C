import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { metadataGit, metadataKind } from './projectMetadataConflicts';

/** Read-only checks after resolution; never invokes stores that might migrate files. */
export async function auditMetadataReferences(root: string): Promise<string[]> {
    const files = [...new Set((await metadataGit(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean))];
    if (files.length > 50000) { return ['Project checks were skipped: more than 50,000 files. Run build diagnostics before committing.']; }
    const warnings: string[] = []; const groups = new Map<string, Set<string>>();
    const references: { file: string; group: string }[] = []; const identities = new Map<string, string>(); const codes = new Map<string, string>();
    const organizationRoots = new Set<string>();
    const candidates = files.filter(file => metadataKind(file) || /(?:^|\/)(?:scen|process|meta)\.yaml$/iu.test(file));
    for (const file of candidates) {
        if (file.split('/').some(part => ['.superpowers', 'node_modules', '.vscode'].includes(part))) { continue; }
        const physical = path.join(root, file);
        try {
            const stat = await fs.lstat(physical); if (!stat.isFile() || stat.size > 1024 * 1024) { continue; }
            const document = parseDocument(await fs.readFile(physical, 'utf8'));
            if (document.errors.length) { warnings.push(`Invalid YAML: ${file}`); continue; }
            const value = document.toJS({ maxAliasCount: 0 }); const kind = metadataKind(file);
            if (kind === 'group') {
                const owner = file.slice(0, file.lastIndexOf('.kot/')); organizationRoots.add(owner);
                const known = groups.get(owner) ?? new Set<string>(); groups.set(owner, known);
                for (const group of [value]) {
                    if (known.has(group.id)) { warnings.push(`Duplicate group ID ${group.id}: ${file}`); } known.add(group.id);
                }
            } else if (kind === 'sidecar') {
                if (value.metadata?.groupId) { references.push({ file, group: value.metadata.groupId }); }
                const uid = value.identity?.uid;
                if (uid) {
                    const normalized = String(uid).toLowerCase(); const previous = identities.get(normalized);
                    if (previous && previous !== file) { warnings.push(`Duplicate metadata UID ${uid}: ${previous}, ${file}`); } else { identities.set(normalized, file); }
                }
            } else if (!kind && ['Сценарий', 'Процесс'].includes(value.ТипФайла)) {
                const header = value.ДанныеСценария ?? value.ДанныеПроцесса; const code = header?.Код;
                if (code !== undefined && String(code).trim()) {
                    const previous = codes.get(String(code));
                    if (previous) { warnings.push(`Duplicate test code ${code}: ${previous}, ${file}`); } else { codes.set(String(code), file); }
                }
            }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { warnings.push(`Could not check ${file}`); } }
    }
    const owners = [...organizationRoots].sort((a, b) => b.length - a.length);
    for (const reference of references) {
        const owner = owners.find(candidate => reference.file.startsWith(candidate));
        if (!groups.get(owner ?? '')?.has(reference.group)) { warnings.push(`Unknown group ${reference.group}: ${reference.file}`); }
    }
    return warnings;
}
