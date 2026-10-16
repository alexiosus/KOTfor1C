import { extractCompilerFeatureProcessCodes } from './compilerArtifacts';

const HEADERS: Readonly<Record<string, string>> = {
    'функциональность': 'Feature', 'функционал': 'Feature', 'свойство': 'Feature',
    'сценарий': 'Scenario', 'структура сценария': 'Scenario Outline',
    'контекст': 'Background', 'предыстория': 'Background', 'примеры': 'Examples', 'правило': 'Rule'
};
const quotedArgument = String.raw`("(?:\\.|""|[^"\\\r\n])*")`;
const connection = new RegExp(String.raw`^([ \t]*)И[ \t]+я[ \t]+подключаю[ \t]+TestClient[ \t]+${quotedArgument}[ \t]+логин[ \t]+${quotedArgument}[ \t]+пароль[ \t]+${quotedArgument}[ \t]*$`, 'iu');

/** Stock ТекстПроцесса omits the language pass used by ТекстСценария.
 * Preserve every line ending so the compiler's .str coordinates remain valid.
 */
export function normalizeCompilerProcessFeatureLanguage(source: string): string {
    if (!/^\uFEFF?#\s*language\s*:\s*en[ \t]*(?:\r\n|\r|\n|$)/iu.test(source)
        || extractCompilerFeatureProcessCodes(source).length === 0) { return source; }
    const chunks = source.split(/(\r\n|\r|\n)/u);
    let fence: string | undefined;
    for (let index = 2; index < chunks.length; index += 2) {
        const line = chunks[index];
        const delimiter = line.match(/^[ \t]*("""|```)/u)?.[1];
        if (delimiter) { fence = fence ? delimiter === fence ? undefined : fence : delimiter; continue; }
        if (fence || /^[ \t]*\|/u.test(line)) { continue; }
        let updated = line.replace(/^([ \t]*(?:\*[ \t]*)?)(Функциональность|Функционал|Свойство|Структура сценария|Сценарий|Контекст|Предыстория|Примеры|Правило)(?=:)/iu,
            (_match, indentation: string, header: string) => indentation + HEADERS[header.toLowerCase()]);
        updated = updated.replace(/^([ \t]*\*[ \t]*)Подпроцесс(?=:)/iu, '$1Subprocess');
        updated = updated.replace(connection, (_match, indentation: string, profile: string, login: string, password: string) =>
            `${indentation}And I connect ${profile} TestClient using ${login} login and ${password} password`);
        updated = updated.replace(/^([ \t]*)И[ \t]+я[ \t]+закрыл[ \t]+все[ \t]+окна[ \t]+клиентского[ \t]+приложения[ \t]*$/iu,
            '$1And I close all client application windows');
        if (/^[ \t]*#\s*language\s*:\s*(?:en|ru)[ \t]*$/iu.test(updated)) { updated = ''; }
        chunks[index] = updated;
    }
    return chunks.join('');
}
