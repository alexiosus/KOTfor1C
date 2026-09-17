export interface ScenarioValidationOptions {
    includeSuggestions: boolean;
    includeStepChecks: boolean;
    includeStepSuggestions?: boolean;
    includeScenarioSuggestions?: boolean;
}

export type ScenarioValidationTrigger = 'full' | 'global' | 'change' | 'save' | 'related';

interface VersionedDocument {
    readonly version: number;
}

interface CancellationState {
    readonly isCancellationRequested: boolean;
}

export function createDocumentValidationCancellation(
    document: VersionedDocument,
    cancellation?: CancellationState
): () => boolean {
    const initialVersion = document.version;
    return () => document.version !== initialVersion
        || cancellation?.isCancellationRequested === true;
}

export function getScenarioValidationOptions(
    trigger: ScenarioValidationTrigger
): ScenarioValidationOptions {
    switch (trigger) {
        case 'full':
            return {
                includeSuggestions: true,
                includeStepChecks: true
            };
        case 'global':
            return {
                includeSuggestions: false,
                includeStepChecks: true
            };
        case 'change':
            return {
                includeSuggestions: false,
                includeStepChecks: true,
                includeStepSuggestions: false,
                includeScenarioSuggestions: false
            };
        case 'save':
            return {
                includeSuggestions: false,
                includeStepChecks: true,
                includeStepSuggestions: true,
                includeScenarioSuggestions: true
            };
        case 'related':
            return {
                includeSuggestions: false,
                includeStepChecks: false
            };
    }
}
