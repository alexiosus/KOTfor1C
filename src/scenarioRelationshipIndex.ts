import type { ScenarioCatalog } from './scenarioCatalog';
import { getScenarioRuntimeKey } from './scenarioRuntimeIdentity';
import type { TestInfo } from './types';

export interface ScenarioRelationshipEntry {
    readonly scenarioKey: string;
    readonly incomingDistance?: number;
    readonly outgoingDistance?: number;
}

export interface ScenarioRelationshipProjection {
    readonly currentScenarioKeys: readonly string[];
    readonly relationships: readonly ScenarioRelationshipEntry[];
    readonly affectedMainScenarioKeys: readonly string[];
    readonly affectedPhaseNames: readonly string[];
}

function isMainScenario(scenario: TestInfo): boolean {
    return typeof scenario.tabName === 'string' && scenario.tabName.trim().length > 0;
}

function compareText(left: string, right: string): number {
    return left.localeCompare(right, undefined, { sensitivity: 'base' })
        || left.localeCompare(right);
}

export class ScenarioRelationshipIndex {
    private constructor(
        private readonly scenariosByKey: ReadonlyMap<string, TestInfo>,
        private readonly outgoingByKey: ReadonlyMap<string, ReadonlySet<string>>,
        private readonly incomingByKey: ReadonlyMap<string, ReadonlySet<string>>,
        private readonly callersByCalleeName: ReadonlyMap<string, ReadonlySet<string>>
    ) {}

    public static fromCatalog(catalog: ScenarioCatalog): ScenarioRelationshipIndex {
        const scenariosByKey = new Map<string, TestInfo>();
        const outgoingByKey = new Map<string, Set<string>>();
        const incomingByKey = new Map<string, Set<string>>();
        const callerNames = new Map<string, Set<string>>();

        for (const scenario of catalog.all) {
            const key = getScenarioRuntimeKey(scenario);
            scenariosByKey.set(key, scenario);
            outgoingByKey.set(key, new Set<string>());
            incomingByKey.set(key, new Set<string>());
        }

        for (const caller of catalog.all) {
            const callerKey = getScenarioRuntimeKey(caller);
            for (const rawCalleeName of caller.nestedScenarioNames ?? []) {
                const calleeName = rawCalleeName.trim();
                if (!calleeName) {
                    continue;
                }

                const callers = callerNames.get(calleeName) ?? new Set<string>();
                callers.add(caller.name);
                callerNames.set(calleeName, callers);

                const candidates = [...(catalog.byName.get(calleeName) ?? [])]
                    .sort((left, right) => compareText(
                        getScenarioRuntimeKey(left),
                        getScenarioRuntimeKey(right)
                    ));
                for (const callee of candidates) {
                    const calleeKey = getScenarioRuntimeKey(callee);
                    outgoingByKey.get(callerKey)?.add(calleeKey);
                    incomingByKey.get(calleeKey)?.add(callerKey);
                }
            }
        }

        const sortedCallerNames = new Map<string, ReadonlySet<string>>();
        for (const calleeName of [...callerNames.keys()].sort(compareText)) {
            sortedCallerNames.set(
                calleeName,
                new Set([...callerNames.get(calleeName)!].sort(compareText))
            );
        }

        return new ScenarioRelationshipIndex(
            scenariosByKey,
            outgoingByKey,
            incomingByKey,
            sortedCallerNames
        );
    }

    public project(currentScenarioKeys: readonly string[]): ScenarioRelationshipProjection {
        const currentKeys = [...new Set(currentScenarioKeys)]
            .filter(key => this.scenariosByKey.has(key))
            .sort((left, right) => this.compareScenarioKeys(left, right));
        const incomingDistances = this.traverse(currentKeys, this.incomingByKey);
        const outgoingDistances = this.traverse(currentKeys, this.outgoingByKey);
        const relationshipKeys = new Set<string>([
            ...incomingDistances.keys(),
            ...outgoingDistances.keys()
        ]);
        for (const currentKey of currentKeys) {
            relationshipKeys.delete(currentKey);
        }

        const relationships = [...relationshipKeys]
            .map(scenarioKey => Object.freeze({
                scenarioKey,
                ...(incomingDistances.has(scenarioKey)
                    ? { incomingDistance: incomingDistances.get(scenarioKey)! }
                    : {}),
                ...(outgoingDistances.has(scenarioKey)
                    ? { outgoingDistance: outgoingDistances.get(scenarioKey)! }
                    : {})
            }))
            .sort((left, right) => {
                const leftDistance = Math.min(
                    left.incomingDistance ?? Number.POSITIVE_INFINITY,
                    left.outgoingDistance ?? Number.POSITIVE_INFINITY
                );
                const rightDistance = Math.min(
                    right.incomingDistance ?? Number.POSITIVE_INFINITY,
                    right.outgoingDistance ?? Number.POSITIVE_INFINITY
                );
                return leftDistance - rightDistance
                    || this.compareScenarioKeys(left.scenarioKey, right.scenarioKey);
            });

        const affectedMainScenarioKeys = [...new Set([
            ...currentKeys,
            ...incomingDistances.keys()
        ])]
            .filter(key => {
                const scenario = this.scenariosByKey.get(key);
                return scenario ? isMainScenario(scenario) : false;
            })
            .sort((left, right) => this.compareScenarioKeys(left, right));
        const affectedPhaseNames = [...new Set(affectedMainScenarioKeys
            .map(key => this.scenariosByKey.get(key)?.tabName?.trim() ?? '')
            .filter(Boolean))]
            .sort(compareText);

        return Object.freeze({
            currentScenarioKeys: Object.freeze(currentKeys),
            relationships: Object.freeze(relationships),
            affectedMainScenarioKeys: Object.freeze(affectedMainScenarioKeys),
            affectedPhaseNames: Object.freeze(affectedPhaseNames)
        });
    }

    public getCallerNamesByCalleeName(): ReadonlyMap<string, ReadonlySet<string>> {
        return this.callersByCalleeName;
    }

    private traverse(
        startKeys: readonly string[],
        adjacency: ReadonlyMap<string, ReadonlySet<string>>
    ): Map<string, number> {
        const distances = new Map<string, number>();
        const queue = startKeys.map(key => ({ key, distance: 0 }));
        const visited = new Set(startKeys);

        for (let index = 0; index < queue.length; index += 1) {
            const current = queue[index];
            const neighbours = [...(adjacency.get(current.key) ?? [])]
                .sort((left, right) => this.compareScenarioKeys(left, right));
            for (const neighbour of neighbours) {
                if (visited.has(neighbour)) {
                    continue;
                }
                visited.add(neighbour);
                const distance = current.distance + 1;
                distances.set(neighbour, distance);
                queue.push({ key: neighbour, distance });
            }
        }

        return distances;
    }

    private compareScenarioKeys(leftKey: string, rightKey: string): number {
        const left = this.scenariosByKey.get(leftKey);
        const right = this.scenariosByKey.get(rightKey);
        return compareText(left?.name ?? '', right?.name ?? '')
            || compareText(leftKey, rightKey);
    }
}
