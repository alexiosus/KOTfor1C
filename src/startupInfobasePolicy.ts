export type SharedStartupInfobaseAction = Readonly<{
    action: 'create' | 'recreate' | 'reuse';
    authentication: 'stored' | 'none';
    reason: 'missing' | 'forced' | 'current' | 'legacy' | 'templateChanged';
}>;

export function decideSharedStartupInfobaseAction(input: Readonly<{
    markerExists: boolean;
    forceRecreate: boolean;
    platform: NodeJS.Platform;
    hasStoredAuthentication: boolean;
    templateDescriptorMatches: boolean;
}>): SharedStartupInfobaseAction {
    if (!input.markerExists) {
        return Object.freeze({ action: 'create', authentication: 'none', reason: 'missing' });
    }
    if (input.forceRecreate) {
        return Object.freeze({ action: 'recreate', authentication: 'none', reason: 'forced' });
    }

    const authentication = input.platform === 'win32' && input.hasStoredAuthentication
        ? 'stored'
        : 'none';
    const reason = authentication === 'none'
        ? 'legacy'
        : input.templateDescriptorMatches
            ? 'current'
            : 'templateChanged';
    return Object.freeze({ action: 'reuse', authentication, reason });
}
