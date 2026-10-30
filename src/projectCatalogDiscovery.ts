import path from 'node:path';
import type { TestInfo } from './types';
import { ProjectPropertyCatalogStore, type ProjectPropertyCatalogs } from './projectPropertyCatalogStore';

/** Consume the scanner's saved descriptors; discovery never triggers another workspace scan. */
export async function discoverProjectCatalogs(root: string, all: readonly TestInfo[], assertSaved: (file: string) => void): Promise<void> {
    const scenarios = all.filter(info => {
        if (info.yamlFileUri.scheme !== 'file') { return false; }
        const relative = path.relative(root, info.yamlFileUri.fsPath);
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    const values: ProjectPropertyCatalogs = { projects: [], reportLevel1: [], reportLevel2: [], responsibles: [], categories: [], systemFunctions: [] };
    for (const info of scenarios) {
        const data = info.catalogValues;
        for (const [key, value] of Object.entries({ projects: data?.project, reportLevel1: data?.reportLevel1, reportLevel2: data?.reportLevel2,
            responsibles: data?.responsible, categories: info.scenarioCategory })) {
            if (value?.trim() && !/[\r\n\0]/u.test(value)) { (values[key as keyof Omit<ProjectPropertyCatalogs, 'systemFunctions'>]).push(value); }
        }
        const fn = data?.systemFunction;
        if (fn && !values.systemFunctions!.some(old => old.uid === fn.uid)) { values.systemFunctions!.push(fn); }
    }
    const store: ProjectPropertyCatalogStore = new ProjectPropertyCatalogStore(root, { beforeWrite: () => assertSaved(store.filePath) });
    assertSaved(store.filePath); await store.mergeDetected(values);
}
