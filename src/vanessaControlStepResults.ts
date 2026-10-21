import { collectGherkinExecutableLines } from './gherkinAnnotations';
import { vanessaFormReplyText } from './vanessaControlForms';
export interface VanessaExecutionLine { readonly lineNumber: number; readonly status: 'running' | 'passed' | 'failed' | 'stopped' | 'unknown' }
/** Result names contain no line IDs in .45. Only exact, unique executable text is safe to associate. */
export function mapVanessaStepResults(reply: unknown, source: string, firstLine = 1): VanessaExecutionLine[] {
    let text: string;
    try { text = vanessaFormReplyText(reply); } catch { return []; }
    if (!text.startsWith('# Результаты тестов\n')) { return []; }
    const parts = text.split('\n## Шаги (');
    if (parts.length !== 2) { return []; }
    const count = /^([1-9]\d*)\)\n/u.exec(parts[1])?.[1];
    const rows = [...parts[1].matchAll(/^([1-9]\d*)\. ([^\n]+) → \*\*(Success|Failed|Broken|Pending)\*\*(?: \([^\n]* мс\))?$/gmu)];
    if (!count || Number(count) !== rows.length || rows.length > 10_000 || rows.some((row, index) => Number(row[1]) !== index + 1)) { return []; }
    const lines = collectGherkinExecutableLines({ text: source, uri: 'file:///runtime.feature', language: /^# language: ru$/mu.test(source) ? 'ru' : 'en' }).filter(line => line.lineNumber >= firstLine);
    const byText = new Map<string, typeof lines>();
    for (const line of lines) {
        const matches = byText.get(line.text);
        if (matches) { matches.push(line); } else { byText.set(line.text, [line]); }
    }
    const result = new Map<number, VanessaExecutionLine>();
    for (const row of rows) {
        const candidates = byText.get(row[2].trim());
        if (candidates?.length !== 1) { continue; }
        const lineNumber = candidates[0].lineNumber;
        const status = row[3] === 'Success' ? 'passed' : row[3] === 'Broken' ? 'stopped' : row[3] === 'Pending' ? 'unknown' : 'failed';
        if (result.get(lineNumber)?.status !== 'failed') { result.set(lineNumber, { lineNumber, status }); }
    }
    return [...result.values()].sort((a, b) => a.lineNumber - b.lineNumber);
}
