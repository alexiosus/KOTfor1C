import * as fs from 'node:fs';
import * as path from 'node:path';

const WINDOWS_1C_INSTALL_ROOTS = [
    'C:\\Program Files\\1cv8',
    'C:\\Program Files (x86)\\1cv8'
];

function compareVersionSegments(left: string, right: string): number {
    const leftSegments = left.split(/[^\d]+/).filter(Boolean).map(Number);
    const rightSegments = right.split(/[^\d]+/).filter(Boolean).map(Number);
    const maxLength = Math.max(leftSegments.length, rightSegments.length);
    for (let index = 0; index < maxLength; index += 1) {
        const leftValue = leftSegments[index] || 0;
        const rightValue = rightSegments[index] || 0;
        if (leftValue !== rightValue) {
            return leftValue - rightValue;
        }
    }

    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function isExistingFile(targetPath: string): boolean {
    try {
        return fs.statSync(targetPath).isFile();
    } catch {
        return false;
    }
}

function listWindowsPlatformCandidates(): string[] {
    const candidates: string[] = [];

    for (const installRoot of WINDOWS_1C_INSTALL_ROOTS) {
        if (!fs.existsSync(installRoot)) {
            continue;
        }

        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(installRoot, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            const clientExePath = path.join(installRoot, entry.name, 'bin', '1cv8c.exe');
            if (isExistingFile(clientExePath)) {
                candidates.push(clientExePath);
            }
        }
    }

    return candidates.sort((leftPath, rightPath) => {
        const leftVersion = path.basename(path.dirname(path.dirname(leftPath)));
        const rightVersion = path.basename(path.dirname(path.dirname(rightPath)));
        return compareVersionSegments(rightVersion, leftVersion);
    });
}

export async function detectInstalledOneCClientExePath(): Promise<string | null> {
    if (process.platform !== 'win32') {
        return null;
    }

    const candidates = listWindowsPlatformCandidates();
    return candidates[0] || null;
}

export function resolveOneCDesignerExePath(oneCClientExePath: string): string {
    const trimmedPath = oneCClientExePath.trim();
    if (!trimmedPath) {
        return trimmedPath;
    }

    const fileName = path.basename(trimmedPath).toLowerCase();
    if (fileName === '1cv8.exe') {
        return trimmedPath;
    }

    if (fileName === '1cv8c.exe') {
        return path.join(path.dirname(trimmedPath), '1cv8.exe');
    }

    return path.join(path.dirname(trimmedPath), '1cv8.exe');
}

export function resolveOneCClientExePath(oneCConfiguredPath: string): string {
    return oneCConfiguredPath.trim();
}
