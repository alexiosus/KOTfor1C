import { parseExportScenarios } from './exportScenarioParser';

export interface StandaloneFeatureGroup {
    readonly id: string;
    readonly name: string;
    /** Set when the same shared ID is present in multiple configured project owners. */
    readonly projectRoot?: string;
}
export interface StandaloneFeatureEntry {
    readonly id: string;
    readonly uri: string;
    readonly name: string;
    readonly title: string;
    readonly relativePath: string;
    readonly language: 'ru' | 'en';
    readonly groupId: string;
    readonly order: number;
    readonly jsonPath?: string;
}
export interface StandaloneFeatureSnapshot {
    readonly features: readonly StandaloneFeatureEntry[];
    readonly groups: readonly StandaloneFeatureGroup[];
    readonly revision: number;
    readonly ordering?: {
        readonly groupRoots: Readonly<Record<string, readonly string[]>>;
        readonly featureRoots: Readonly<Record<string, string>>;
    };
}
export interface StandaloneFeatureSourceMetadata {
    readonly title: string;
    readonly language: 'ru' | 'en';
    readonly exportOnly: boolean;
}

export function parseStandaloneFeatureSource(
    source: string,
    name: string
): StandaloneFeatureSourceMetadata {
    const firstFeature = /(?:^|\n)\s*(Feature|Functionality|Business Need|Ability|Функциональность|Функционал|Функция)\s*:/iu.exec(source.replace(/^\uFEFF/u, ''));
    const defaultLanguage = /[A-Za-z]/u.test(firstFeature?.[1] ?? '') ? 'en' : 'ru';
    const normalizedSource = source.replace(/^(\s*)Functionality(?=\s*:)/gimu, '$1Feature');
    const parsed = parseExportScenarios(normalizedSource, {
        sourceUri: '', workspaceFolderUri: '', profileId: '', libraryRootUri: '', sourceLabel: '', defaultLanguage
    });
    return Object.freeze({
        title: parsed.feature?.title || name,
        language: parsed.language,
        exportOnly: parsed.feature?.hasExportTag === true
            || (parsed.scenarios.length > 0 && parsed.scenarios.every(scenario => scenario.exported))
    });
}
