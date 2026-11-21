/** Keep file names outside Gherkin interpolation and executable BSL literals. */
export function buildVanessaMxlStep(filePath: string, resultPath: string): string {
    if (![filePath, resultPath].every(value => value && !/[\r\n\0]/u.test(value))) { throw new Error('Invalid MXL file path.'); }
    const decode = (value: string) => `ПолучитьСтрокуИзДвоичныхДанных(Base64Значение("${Buffer.from(value, 'utf8').toString('base64')}"), КодировкаТекста.UTF8)`;
    return ['И я выполняю код встроенного языка', '"""bsl',
        `KOTMxlFile = ${decode(filePath)};`, `KOTMxlResultPath = ${decode(resultPath)};`,
        'KOTMxlResult = Новый Структура("opened", Ложь);', 'Попытка',
        '    KOTMxlDocument = Ванесса.ПолучитьМакетИзФайла(KOTMxlFile);',
        '    KOTMxlDocument.Показать(KOTMxlFile);', '    KOTMxlResult.opened = Истина;',
        'Исключение', '    KOTMxlResult.Вставить("error", ОписаниеОшибки());', 'КонецПопытки;',
        'KOTMxlWriter = Новый ЗаписьJSON;', 'KOTMxlWriter.ОткрытьФайл(KOTMxlResultPath);',
        'ЗаписатьJSON(KOTMxlWriter, KOTMxlResult);', 'KOTMxlWriter.Закрыть();', '"""'].join('\n');
}

export function readMxlOpeningResult(text: string): void {
    const result = JSON.parse(text) as { opened?: unknown; error?: unknown };
    if (result?.opened !== true) { throw new Error(typeof result?.error === 'string' ? result.error : '1C did not confirm opening the MXL file.'); }
}
