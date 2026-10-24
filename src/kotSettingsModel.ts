import fs from 'node:fs/promises';
import path from 'node:path';
import type { SettingSchema } from './kotSettingsSession';

export interface SettingsPresentation {
    key: string; label: string; labelEn: string; section: string; advanced?: boolean; compatibility?: boolean;
    editor?: string; hint?: string; placeholder?: string; inheritsFrom?: string; preferredScope?: string;
    optionLabels?: string[]; itemEnum?: string[]; choiceLabels?: string[]; pathKind?: string; pathPolicy?: 'relative' | 'absolute' | 'project';
}
export interface SettingsDefinition extends SettingSchema, SettingsPresentation { description: string; configScope?: string; manager?: string }
export interface KotSettingsModel {
    sections: Array<{ id: string; title: string; description: string }>;
    settings: SettingsDefinition[]; strings: Record<string, string>; russian: boolean;
}
export const settingsManagers: Record<string, string> = {
    'kotTestToolkit.catalogs.systemFunctions': 'kotTestToolkit.manageSystemFunctions',
    'kotTestToolkit.numbering.series': 'kotTestToolkit.manageTestNumbering',
    'kotTestToolkit.paths.openBuildScenarioParametersManager': 'kotTestToolkit.openYamlParametersManager',
    'kotTestToolkit.platforms.catalog': 'kotTestToolkit.managePlatforms'
};
export async function loadKotSettingsModel(extensionPath: string, russian: boolean): Promise<KotSettingsModel> {
    const read = async (file: string) => JSON.parse(await fs.readFile(path.join(extensionPath, file), 'utf8'));
    const [manifest, presentation, nls, bundle] = await Promise.all([read('package.json'), read('media/kotSettingsModel.json'),
        read(russian ? 'package.nls.ru.json' : 'package.nls.json'), russian ? read('l10n/bundle.l10n.ru.json') : Promise.resolve({})]);
    const properties: Record<string, SettingSchema & { description?: string; markdownDescription?: string; scope?: string }> = Object.assign({}, ...manifest.contributes.configuration.map((section: { properties: object }) => section.properties));
    const labels = new Map<string, SettingsPresentation>(presentation.settings.map((item: SettingsPresentation) => [item.key, item]));
    const localize = (text: string | undefined) => text?.replace(/^%(.+)%$/u, (_, key: string) => nls[key] ?? key) ?? '';
    const settings: SettingsDefinition[] = Object.entries(properties).map(([key, schema]) => {
        const item = labels.get(key);
        if (!item) { throw new Error(`Missing settings presentation: ${key}`); }
        return { ...schema, ...item, key, label: russian ? item.label : item.labelEn, configScope: schema.scope ?? 'window',
            secret: key === 'kotTestToolkit.ai.apiKey', description: localize(schema.markdownDescription ?? schema.description),
            hint: russian ? item.hint : undefined, optionLabels: russian ? item.optionLabels : undefined,
            manager: settingsManagers[key] };
    });
    return { sections: presentation.sections.map((section: { id: string; title: string; titleEn: string; description: string }) => ({
        id: section.id, title: russian ? section.title : section.titleEn, description: russian ? section.description : ''
    })), settings, strings: bundle, russian };
}
