export interface ProjectBranchRefreshServices {
    invalidateLibrary(): void;
    reloadScenarios(): Promise<unknown>;
    reloadDefinitions(): Promise<unknown>;
    reloadStandalone(): Promise<unknown>;
}
/** A branch may replace the whole corpus without changing any configured folder. */
export async function refreshProjectBranch(services: ProjectBranchRefreshServices): Promise<void> {
    services.invalidateLibrary();
    await services.reloadScenarios();
    await Promise.all([services.reloadDefinitions(),services.reloadStandalone()]);
    services.invalidateLibrary();
}
