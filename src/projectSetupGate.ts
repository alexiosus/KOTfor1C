import path from 'node:path';

const states = new Map<string, boolean>();
const listeners = new Set<(root: string) => void>();
const normalize = (root: string) => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
export function isProjectSetupPending(file: string): boolean {
    const candidate = normalize(file);
    const owner = [...states.keys()].filter(root => candidate === root || candidate.startsWith(root + path.sep)).sort((a, b) => b.length - a.length)[0];
    return owner !== undefined && states.get(owner) === true;
}
export function deferProjectSetup(root: string): void { states.set(normalize(root), true); }
export function completeProjectSetup(root: string): void {
    states.set(normalize(root), false); for (const listener of listeners) { listener(root); }
}
export function onProjectSetupCompleted(listener: (root: string) => void): { dispose(): void } {
    listeners.add(listener); return { dispose: () => { listeners.delete(listener); } };
}
