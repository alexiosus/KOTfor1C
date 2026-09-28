export interface YamlParameterLike {
    key: string;
    value: string;
}

export interface OverridableYamlParameterLike extends YamlParameterLike {
    overrideExisting: boolean;
}

export interface YamlParametersProfileLike {
    id: string;
    name: string;
    buildParameters: YamlParameterLike[];
    additionalVanessaParameters: OverridableYamlParameterLike[];
    globalVanessaVariables: OverridableYamlParameterLike[];
}

export interface YamlParametersStateLike {
    activeProfileId: string;
    profiles: YamlParametersProfileLike[];
}

export interface ActiveYamlParametersProfile {
    readonly id: string;
    readonly name: string;
    readonly buildParameters: readonly Readonly<YamlParameterLike>[];
    readonly additionalVanessaParameters: readonly Readonly<OverridableYamlParameterLike>[];
    readonly globalVanessaVariables: readonly Readonly<OverridableYamlParameterLike>[];
}

export interface ActiveYamlParametersProfileChangeEvent {
    readonly oldProfileId: string;
    readonly newProfileId: string;
    readonly reason: 'selection' | 'content';
}

function getActiveProfile(state: YamlParametersStateLike): YamlParametersProfileLike {
    const profile = state.profiles.find(candidate => candidate.id === state.activeProfileId)
        ?? state.profiles[0];
    if (!profile) {
        throw new Error('YAML parameters state must contain at least one profile.');
    }
    return profile;
}

function freezeCopies<T extends object>(values: readonly T[]): readonly Readonly<T>[] {
    return Object.freeze(values.map(value => Object.freeze({ ...value })));
}

export function createActiveYamlParametersProfileSnapshot(
    state: YamlParametersStateLike
): ActiveYamlParametersProfile {
    const profile = getActiveProfile(state);
    return Object.freeze({
        id: profile.id,
        name: profile.name,
        buildParameters: freezeCopies(profile.buildParameters),
        additionalVanessaParameters: freezeCopies(profile.additionalVanessaParameters),
        globalVanessaVariables: freezeCopies(profile.globalVanessaVariables)
    });
}

export function getActiveYamlParametersProfileChange(
    previousState: YamlParametersStateLike,
    nextState: YamlParametersStateLike
): ActiveYamlParametersProfileChangeEvent | null {
    const previous = getActiveProfile(previousState);
    const next = getActiveProfile(nextState);
    if (previous.id !== next.id) {
        return {
            oldProfileId: previous.id,
            newProfileId: next.id,
            reason: 'selection'
        };
    }
    if (JSON.stringify(previous) === JSON.stringify(next)) {
        return null;
    }
    return {
        oldProfileId: previous.id,
        newProfileId: next.id,
        reason: 'content'
    };
}
