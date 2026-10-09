export function resolveMainScenarioGroupSeed(seed: unknown): string | undefined {
    if (!seed || typeof seed !== 'object' || Array.isArray(seed)) {
        return undefined;
    }
    const groupName = (seed as { groupName?: unknown }).groupName;
    if (typeof groupName !== 'string') {
        return undefined;
    }
    return groupName.trim() || undefined;
}
