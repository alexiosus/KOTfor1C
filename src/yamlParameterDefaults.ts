export interface DefaultableYamlParameter {
    key: string;
    value: string;
}

function normalizeKey(value: string): string {
    return value.trim().toLowerCase().replace(/[_\-\s]/g, '');
}

export function ensureDefaultLibrariesParameter(
    parameters: readonly DefaultableYamlParameter[]
): DefaultableYamlParameter[] {
    const copied = parameters.map(parameter => ({ ...parameter }));
    if (copied.some(parameter => normalizeKey(parameter.key) === 'libraries')) {
        return copied;
    }

    const vanessaIndex = copied.findIndex(parameter =>
        ['vanessafolder', 'vanessadir', 'vanessapath'].includes(normalizeKey(parameter.key))
    );
    const vanessaFolder = vanessaIndex >= 0 ? copied[vanessaIndex].value.trim() : '';
    const libraries = {
        key: 'Libraries',
        value: path.join(vanessaFolder, 'features', 'Libraries')
    };
    copied.splice(vanessaIndex >= 0 ? vanessaIndex + 1 : copied.length, 0, libraries);
    return copied;
}
import path from 'node:path';
