import * as path from 'node:path';
import type { ManagedInfobaseRecord } from './infobaseManager';
import type { Translator } from './localization';

export type DestructiveInfobaseImportKind = 'dt' | 'cf' | 'sourceDirectory';

export interface DestructiveInfobaseImportConfirmation {
    readonly title: string;
    readonly detail: string;
    readonly confirmLabel: string;
}

interface DestructiveImportCopy {
    readonly title: string;
    readonly consequence: string;
    readonly confirmLabel: string;
}

export function buildDestructiveInfobaseImportConfirmation(
    kind: DestructiveInfobaseImportKind,
    sourcePath: string,
    target: Pick<ManagedInfobaseRecord, 'displayName' | 'infobasePath'>,
    t: Translator
): DestructiveInfobaseImportConfirmation {
    const copy: Record<DestructiveInfobaseImportKind, DestructiveImportCopy> = {
        dt: {
            title: t('Restore "{0}" from DT?', target.displayName),
            consequence: t('All current infobase data and configuration will be replaced.'),
            confirmLabel: t('Restore DT')
        },
        cf: {
            title: t('Load CF into "{0}"?', target.displayName),
            consequence: t('The current infobase configuration will be replaced and the database configuration will be updated.'),
            confirmLabel: t('Load CF')
        },
        sourceDirectory: {
            title: t('Load configuration source into "{0}"?', target.displayName),
            consequence: t('The current infobase configuration will be replaced and the database configuration will be updated.'),
            confirmLabel: t('Load source directory')
        }
    };
    const selected = copy[kind];
    const normalizedSourcePath = path.normalize(path.resolve(sourcePath));
    return Object.freeze({
        title: selected.title,
        detail: [
            t('Source: {0}', normalizedSourcePath),
            t('Target: {0}', target.displayName),
            t('Connection: {0}', target.infobasePath),
            '',
            selected.consequence
        ].join('\n'),
        confirmLabel: selected.confirmLabel
    });
}
