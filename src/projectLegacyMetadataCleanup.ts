import { ScenarioYamlDocument } from './scenarioYamlDocument';

/** Drop only the legacy KOT fields represented by the sidecar. Preserve unknown consumers' fields. */
export function removeMigratedKotMetadata(source: string): string {
    const document = ScenarioYamlDocument.parse(source);
    if (document.errors.length) { return source; }
    const field = document.findFieldAtPath(['KOTМетаданные']);
    if (!field || field.ambiguous || field.valueKind !== 'mapping') { return source; }
    const value = field.value as Record<string, unknown>;
    if (Object.keys(value).some(key => !['Описание', 'Категория', 'PhaseSwitcher'].includes(key))) { return source; }
    const phase = value.PhaseSwitcher;
    if (phase !== undefined && phase !== null && (typeof phase !== 'object' || Array.isArray(phase)
        || Object.keys(phase).some(key => !['Tab', 'OrderOnTab', 'Default'].includes(key)))) { return source; }
    return source.slice(0, field.pairRange.start) + source.slice(field.pairRange.end);
}
