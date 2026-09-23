import { createHash } from 'node:crypto';
import type * as vscode from 'vscode';
import type { TestInfo } from './types';
import {
    createProjectDefinitionView,
    normalizeProjectDefinitionTemplate,
    type ProjectDefinition,
    type ProjectDefinitionParameter,
    type ProjectDefinitionResolution,
    type ProjectDefinitionSnapshot,
    type ProjectDefinitionView
} from './projectDefinition';
import { resolveProjectInvocation } from './projectDefinitionMatcher';
import type {
    CancellationTokenLike,
    DisposableLike,
    ProjectDefinitionIndexProvider,
    ProjectDefinitionSnapshotChangeEvent
} from './projectDefinitionIndexService';
import type { ScenarioCatalog, ScenarioCatalogProvider } from './scenarioCatalog';
import {
    executableStepDefinitions,
    type BuiltInStepDefinition,
    type ResolvedStepCatalog,
    type StepTextVariant
} from './stepCatalog';
import type { StepCatalogChangeEvent } from './stepCatalogService';

export interface ProjectDefinitionViewChangeEvent {
    readonly workspaceFolderUri?: string;
    readonly reason: 'local' | 'scenario' | 'builtIn';
}

export interface ProjectDefinitionStepCatalogProvider {
    getCatalog(documentUri?: vscode.Uri): Promise<ResolvedStepCatalog>;
    readonly onDidChangeCatalog: vscode.Event<StepCatalogChangeEvent>;
}

export interface ProjectDefinitionResolverDependencies {
    readonly local: ProjectDefinitionIndexProvider;
    readonly scenarios: ScenarioCatalogProvider;
    readonly steps: ProjectDefinitionStepCatalogProvider;
}

class SimpleEmitter<T> implements DisposableLike {
    readonly #listeners = new Set<(event: T) => void>();

    readonly event = (listener: (event: T) => void): DisposableLike => {
        this.#listeners.add(listener);
        return { dispose: () => this.#listeners.delete(listener) };
    };

    fire(event: T): void {
        for (const listener of [...this.#listeners]) {
            listener(event);
        }
    }

    dispose(): void {
        this.#listeners.clear();
    }
}

function quotedParameterHints(template: string): string[] {
    const hints: string[] = [];
    for (let index = 0; index < template.length; index++) {
        const quote = template[index];
        if (quote !== '"' && quote !== "'") {
            continue;
        }
        const end = template.indexOf(quote, index + 1);
        if (end < 0) {
            break;
        }
        hints.push(template.slice(index + 1, end));
        index = end;
    }
    return hints;
}

function templateParameters(
    template: string,
    suppliedNames: readonly string[] = []
): readonly ProjectDefinitionParameter[] {
    return Object.freeze(quotedParameterHints(template).map((hint, index) => {
        const catalogHint = /^%\d+\s+(.+)$/u.exec(hint)?.[1]?.trim();
        return Object.freeze({
            name: suppliedNames[index] || catalogHint || hint || `Parameter${index + 1}`,
            index,
            source: 'quoted' as const
        });
    }));
}

function builtInVariant(
    catalog: ResolvedStepCatalog,
    step: BuiltInStepDefinition,
    language: 'ru' | 'en',
    variant: StepTextVariant
): ProjectDefinition {
    return Object.freeze({
        id: `${step.id}:${language}`,
        kind: 'builtInStep',
        template: variant.pattern,
        normalizedTemplate: normalizeProjectDefinitionTemplate(variant.pattern),
        language,
        parameters: templateParameters(variant.pattern),
        description: variant.description || undefined,
        sourceLabel: `Vanessa ${catalog.catalogVersion} (${language.toLocaleUpperCase()})`
    });
}

function builtInDefinitions(catalog: ResolvedStepCatalog): readonly ProjectDefinition[] {
    const result: ProjectDefinition[] = [];
    for (const step of executableStepDefinitions(catalog.steps)) {
        if (step.ru) {
            result.push(builtInVariant(catalog, step, 'ru', step.ru));
        }
        if (step.en) {
            result.push(builtInVariant(catalog, step, 'en', step.en));
        }
    }
    return result;
}

function scenarioLocation(scenario: TestInfo) {
    const line = scenario.scenarioCodeLine ?? 0;
    const startCharacter = scenario.scenarioCodeLineStartCharacter ?? 0;
    const endCharacter = scenario.scenarioCodeLineEndCharacter ?? startCharacter;
    return Object.freeze({
        uri: scenario.yamlFileUri.toString(),
        range: Object.freeze({
            start: Object.freeze({ line, character: startCharacter }),
            end: Object.freeze({ line, character: endCharacter })
        })
    });
}

function nestedDefinition(scenario: TestInfo): ProjectDefinition {
    const uri = scenario.yamlFileUri.toString();
    const parameters = (scenario.parameters ?? [])
        .map(name => name.trim())
        .filter(Boolean)
        .map((name, index) => Object.freeze({
            name,
            index,
            source: 'snippet' as const,
            defaultValue: scenario.parameterDefaults?.[name]
        }));
    return Object.freeze({
        id: uri,
        kind: 'nestedScenario',
        template: scenario.name,
        normalizedTemplate: normalizeProjectDefinitionTemplate(scenario.name),
        parameters: Object.freeze(parameters),
        description: scenario.scenarioDescription || undefined,
        sourceLabel: `Nested scenario (${scenario.relativePath || scenario.name})`,
        definitionLocation: scenarioLocation(scenario)
    });
}

function scenarioIdentity(catalog: ScenarioCatalog): string {
    const hash = createHash('sha256');
    const signatures = catalog.all.map(scenario => ({
        uri: scenario.yamlFileUri.toString(),
        name: scenario.name,
        parameters: scenario.parameters ?? [],
        description: scenario.scenarioDescription ?? ''
    })).sort((left, right) =>
        left.uri.localeCompare(right.uri)
        || left.name.localeCompare(right.name)
        || JSON.stringify(left.parameters).localeCompare(JSON.stringify(right.parameters))
    );
    hash.update(JSON.stringify(signatures), 'utf8');
    return `scenarios:${hash.digest('hex')}`;
}

function compositeIdentity(
    builtInIdentity: string,
    nestedIdentity: string,
    localIdentity: string
): string {
    return `project-view:${createHash('sha256')
        .update(`${builtInIdentity}\0${nestedIdentity}\0${localIdentity}`, 'utf8')
        .digest('hex')}`;
}

export class ProjectDefinitionResolver implements DisposableLike {
    readonly #dependencies: ProjectDefinitionResolverDependencies;
    readonly #emitter = new SimpleEmitter<ProjectDefinitionViewChangeEvent>();
    readonly #subscriptions: DisposableLike[];
    readonly #views = new Map<string, ProjectDefinitionView>();

    readonly onDidChangeView = this.#emitter.event;

    constructor(dependencies: ProjectDefinitionResolverDependencies) {
        this.#dependencies = dependencies;
        this.#subscriptions = [
            dependencies.local.onDidChangeSnapshot(event => this.#onLocalChange(event)),
            dependencies.scenarios.onDidUpdateScenarioCatalog(() => {
                this.#views.clear();
                this.#emitter.fire({ reason: 'scenario' });
            }),
            dependencies.steps.onDidChangeCatalog(event => {
                this.#views.clear();
                this.#emitter.fire({
                    workspaceFolderUri: event.workspaceFolderUri?.toString(),
                    reason: 'builtIn'
                });
            })
        ];
    }

    async getView(resource?: vscode.Uri): Promise<ProjectDefinitionView> {
        const local = this.#dependencies.local.getSnapshot(resource);
        const currentScenarios = this.#dependencies.scenarios.getScenarioCatalog();
        const [steps, scenarios] = await Promise.all([
            this.#dependencies.steps.getCatalog(resource),
            currentScenarios
                ? Promise.resolve(currentScenarios)
                : this.#dependencies.scenarios.ensureFreshScenarioCatalog()
        ]);
        const nestedIdentity = scenarioIdentity(scenarios);
        const identity = compositeIdentity(
            steps.identity,
            nestedIdentity,
            local?.identity ?? 'local:unavailable'
        );
        const cached = this.#views.get(identity);
        if (cached) {
            return cached;
        }
        const view = createProjectDefinitionView(identity, [
            ...builtInDefinitions(steps),
            ...(local?.definitions ?? []),
            ...scenarios.all.map(nestedDefinition)
        ]);
        this.#views.set(identity, view);
        return view;
    }

    async ensureReady(
        resource?: vscode.Uri,
        token?: CancellationTokenLike
    ): Promise<ProjectDefinitionView> {
        await this.#dependencies.local.ensureReady(resource, token);
        return this.getView(resource);
    }

    async resolve(
        resource: vscode.Uri | undefined,
        invocation: string,
        view?: ProjectDefinitionView
    ): Promise<ProjectDefinitionResolution> {
        return resolveProjectInvocation(view ?? await this.getView(resource), invocation);
    }

    dispose(): void {
        for (const subscription of this.#subscriptions) {
            subscription.dispose();
        }
        this.#views.clear();
        this.#emitter.dispose();
    }

    #onLocalChange(event: ProjectDefinitionSnapshotChangeEvent): void {
        this.#views.clear();
        this.#emitter.fire({
            workspaceFolderUri: event.current.workspaceFolderUri,
            reason: 'local'
        });
    }
}
