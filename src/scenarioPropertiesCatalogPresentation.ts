import type { ScenarioPropertiesModel } from './scenarioPropertiesModel';
import type { ScenarioPropertiesCatalogs } from './scenarioPropertiesCatalogs';

/** Presentation uses stock values; identifiers are only option values, never labels. */
export function applyPropertyCatalogPresentation(model: ScenarioPropertiesModel, catalogs: ScenarioPropertiesCatalogs): void {
    const values: Record<string, string[]> = { Проект: catalogs.projects, УровеньОтчета1: catalogs.reportLevel1,
        УровеньОтчета2: catalogs.reportLevel2, ПрофильПользователя: catalogs.userProfiles, Ответственный: catalogs.responsibles ?? [] };
    const settings = model.kind === 'test' || model.kind === 'processTest';
    const baseId = model.header.find(field => field.key === 'ИдентификаторБазы')?.value || '';
    const baseName = model.header.find(field => field.key === 'ЭталоннаяБазаИмя')?.value || '';
    const same = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
    const matchingBases = catalogs.bases.filter(base => same(base.id, baseId) && same(base.name, baseName));
    const currentBase = matchingBases.length === 1 ? matchingBases[0] : undefined;
    for (const field of model.header) {
        if (values[field.key]) {
            field.choices = ['', ...values[field.key]]; field.createAction = 'createChoice'; field.action = 'catalogChoice'; delete field.suggestions;
        }
        if (field.key === 'ФункцияСистемы') {
            const uid = (model.header.find(field => field.key === 'UIDФункцияСистемы')?.value || '').toLocaleLowerCase();
            const previousName = field.choiceLabels?.[uid] || field.value;
            field.value = uid; field.choices = catalogs.systemFunctions.map(value => value.uid);
            field.choiceLabels = Object.fromEntries(catalogs.systemFunctions.map(value => [value.uid, value.name]));
            field.choiceLabels[uid] ??= previousName || 'Missing reference';
            field.readonly = false; field.action = 'catalogChoice'; field.createAction = 'createChoice';
        }
        if (settings && field.key === 'ЭталоннаяБазаИмя') {
            field.value = currentBase?.id ?? '__kot_missing_base__';
            field.choices = catalogs.bases.map(base => base.id);
            field.choiceLabels = Object.fromEntries(catalogs.bases.map(base => [base.id, base.name]));
            field.choiceLabels.__kot_missing_base__ = baseName || 'Select infobase';
            field.action = 'catalogChoice'; field.createAction = 'createChoice';
        }
        if (settings && field.key === 'ПрофильПользователя') {
            field.choices = ['', ...(currentBase?.profiles ?? [])];
        }
    }
}
