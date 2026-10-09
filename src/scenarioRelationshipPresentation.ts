export type ScenarioRelationshipSurface = 'testManager' | 'stepLibrary';

export interface ScenarioRelationshipPresentationMode {
    readonly highlight: boolean;
    readonly filter: boolean;
}

export type ScenarioRelationshipPresentationOption = keyof ScenarioRelationshipPresentationMode;

interface ConfigurationLike {
    get<T>(section: string, defaultValue?: T): T | undefined;
    update(section: string, value: unknown, configurationTarget?: unknown): Thenable<void>;
}

interface DisposableLike {
    dispose(): void;
}

interface ConfigurationChangeLike {
    affectsConfiguration?(section: string): boolean;
}

export interface ScenarioRelationshipPresentationDependencies {
    readonly getConfiguration: () => ConfigurationLike;
    readonly workspaceConfigurationTarget: unknown;
    readonly onDidChangeConfiguration: (
        listener: (event: ConfigurationChangeLike) => unknown
    ) => DisposableLike;
}

export interface ScenarioRelationshipPresentationChangeEvent {
    readonly surface: ScenarioRelationshipSurface;
    readonly mode: ScenarioRelationshipPresentationMode;
}

const CONFIGURATION_KEYS: Readonly<Record<ScenarioRelationshipSurface, {
    readonly highlight: string;
    readonly filter: string;
}>> = Object.freeze({
    testManager: Object.freeze({
        highlight: 'phaseSwitcher.highlightAffectedMainScenarios',
        filter: 'phaseSwitcher.filterRelatedScenarios'
    }),
    stepLibrary: Object.freeze({
        highlight: 'stepLibrary.highlightScenarioRelationships',
        filter: 'stepLibrary.filterRelatedScenarios'
    })
});

const FULL_CONFIGURATION_PREFIX = 'kotTestToolkit.';

export class ScenarioRelationshipPresentationService implements DisposableLike {
    private readonly listeners = new Set<(
        event: ScenarioRelationshipPresentationChangeEvent
    ) => unknown>();
    private readonly configurationSubscription: DisposableLike;

    public readonly onDidChangeMode = (
        listener: (event: ScenarioRelationshipPresentationChangeEvent) => unknown
    ): DisposableLike => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    public constructor(private readonly dependencies: ScenarioRelationshipPresentationDependencies) {
        this.configurationSubscription = dependencies.onDidChangeConfiguration(event => {
            for (const surface of Object.keys(CONFIGURATION_KEYS) as ScenarioRelationshipSurface[]) {
                const keys = CONFIGURATION_KEYS[surface];
                const affectsSurface = typeof event.affectsConfiguration !== 'function'
                    || event.affectsConfiguration(`${FULL_CONFIGURATION_PREFIX}${keys.highlight}`)
                    || event.affectsConfiguration(`${FULL_CONFIGURATION_PREFIX}${keys.filter}`);
                if (!affectsSurface) {
                    continue;
                }
                const change = Object.freeze({ surface, mode: this.getMode(surface) });
                for (const listener of [...this.listeners]) {
                    listener(change);
                }
            }
        });
    }

    public getMode(surface: ScenarioRelationshipSurface): ScenarioRelationshipPresentationMode {
        const keys = CONFIGURATION_KEYS[surface];
        const configuration = this.dependencies.getConfiguration();
        return Object.freeze({
            highlight: configuration.get<boolean>(keys.highlight, true) ?? true,
            filter: configuration.get<boolean>(keys.filter, false) ?? false
        });
    }

    public isActive(surface: ScenarioRelationshipSurface): boolean {
        const mode = this.getMode(surface);
        return mode.highlight || mode.filter;
    }

    public async setMode(
        surface: ScenarioRelationshipSurface,
        mode: ScenarioRelationshipPresentationMode
    ): Promise<void> {
        const keys = CONFIGURATION_KEYS[surface];
        const configuration = this.dependencies.getConfiguration();
        await configuration.update(
            keys.highlight,
            mode.highlight,
            this.dependencies.workspaceConfigurationTarget
        );
        await configuration.update(
            keys.filter,
            mode.filter,
            this.dependencies.workspaceConfigurationTarget
        );
    }

    public async toggleMode(
        surface: ScenarioRelationshipSurface,
        option: ScenarioRelationshipPresentationOption
    ): Promise<void> {
        const keys = CONFIGURATION_KEYS[surface];
        const current = this.getMode(surface);
        await this.dependencies.getConfiguration().update(
            keys[option],
            !current[option],
            this.dependencies.workspaceConfigurationTarget
        );
    }

    public dispose(): void {
        this.configurationSubscription.dispose();
        this.listeners.clear();
    }
}
