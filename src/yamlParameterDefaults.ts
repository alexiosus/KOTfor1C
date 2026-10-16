import * as path from 'node:path';
import { findCompilerBuildParameter } from './compilerBuildParameters';

export const DEFAULT_SCENARIO_SOURCE_ROOT = 'tests/';

export interface DefaultableYamlParameter {
    key: string;
    value: string;
}

export function getDefaultAdditionalVanessaParameters(): Array<DefaultableYamlParameter & { overrideExisting: boolean }> {
    return [
        { key: 'ИспользоватьКомпонентуVanessaExt', value: 'true', overrideExisting: true },
        { key: 'ИспользоватьПарсерGherkinИзКомпонентыVanessaExt', value: 'true', overrideExisting: true },
        { key: 'ПоискФайловСПомощьюКомпонентыVanessaExt', value: 'true', overrideExisting: true },
        { key: 'ShowHelperOnFirstLaunch', value: 'false', overrideExisting: true }
    ];
}

/** Keep an editable slot for additional libraries; never shadow a saved alias. */
export function ensureDefaultLibrariesParameter(
    parameters: readonly DefaultableYamlParameter[]
): DefaultableYamlParameter[] {
    const result = parameters.map(parameter => ({ ...parameter }));
    if (!findCompilerBuildParameter(result, 'Libraries', 'VanessaLibraries')) {
        result.push({ key: 'Libraries', value: '' });
    }
    return result;
}
/** Supply absent defaults only. An explicit blank or false is a saved choice. */
export function applyCompilerProfileDefaults(parameters: readonly DefaultableYamlParameter[], runtimeDirectory: string): DefaultableYamlParameter[] {
    const defaults = [
        { key: 'ExternalMode', value: 'True', aliases: ['ExternalMode'] },
        { key: 'CreateJson', value: 'True', aliases: ['CreateJson'] },
        { key: 'CreateJUnit', value: 'True', aliases: ['CreateJUnit'] },
        { key: 'CreateModellingXML', value: 'True', aliases: ['CreateModellingXML'] },
        { key: 'AllureFolder', value: path.join(runtimeDirectory, 'reports', 'allure'), aliases: ['AllureFolder', 'AllurePath'] },
        { key: 'JUnitFolder', value: path.join(runtimeDirectory, 'reports', 'junit'), aliases: ['JUnitFolder', 'JUnitPath'] },
        { key: 'BDDLogFolder', value: path.join(runtimeDirectory, 'logs', 'errors'), aliases: ['BDDLogFolder'] },
        { key: 'ScreenshotsFolder', value: path.join(runtimeDirectory, 'screenshots'), aliases: ['ScreenshotsFolder', 'ScreenshotsPath'] }
    ];
    return ensureDefaultLibrariesParameter([
        ...parameters,
        ...defaults.filter(item => !findCompilerBuildParameter(parameters, ...item.aliases)).map(({ key, value }) => ({ key, value }))
    ]);
}
