import { collectGherkinExecutableLines } from './gherkinAnnotations';
import { vanessaFormReplyText } from './vanessaControlForms';
export interface VanessaExecutionLine { readonly lineNumber: number; readonly status: 'running' | 'passed' | 'failed' | 'stopped' | 'unknown' | 'skipped' }
export interface VanessaResultStepSource { readonly lineNumber: number; readonly text: string }
export interface VanessaResultSourceMap {
    readonly steps: readonly VanessaResultStepSource[];
    isCurrent(): Promise<boolean>;
}
/** Without line IDs, only unique text or a unique ordered alignment proves a source occurrence. */
export function mapVanessaStepResults(reply: unknown, source: string, firstLine = 1, scenarioName?: string, expandedSteps?: readonly VanessaResultStepSource[]): VanessaExecutionLine[] {
    let text: string;
    try { text = vanessaFormReplyText(reply); } catch { return []; }
    if (!text.startsWith('# Результаты тестов\n')) { return []; }
    const parts = text.split('\n## Шаги (');
    if (parts.length !== 2) { return []; }
    const count = /^([1-9]\d*)\)\n/u.exec(parts[1])?.[1];
    const rows = [...parts[1].matchAll(/^([1-9]\d*)\. ([^\n]+) → \*\*(Success|Failed|Broken|Pending|Skipped)\*\*(?: \([^\n]* мс\))?$/gmu)];
    if (!count || Number(count) !== rows.length || rows.length > 10_000 || rows.some((row, index) => Number(row[1]) !== index + 1)) { return []; }
    const headers = source.split(/\r\n|\n|\r/u).flatMap((line, index) => {
        const match = /^\s*(?:Scenario(?: Outline)?|Сценарий|Структура сценария):\s*(.+)$/iu.exec(line);
        return match ? [{ line: index + 1, name: match[1].trim() }] : [];
    });
    const key = (value: string) => value.trim().replace(/^\*\s*/u, '');
    const ordered = rows.map(row => key(row[2]));
    const backgroundEnd = headers[0]?.line ?? 0;
    const allLines = (expandedSteps ?? collectGherkinExecutableLines({ text: source, uri: 'file:///runtime.feature', language: /^# language: ru$/mu.test(source) ? 'ru' : 'en' }))
        .filter(line => line.lineNumber >= firstLine || line.lineNumber < backgroundEnd);
    const scope = (owner: typeof headers[number]) => {
        const end = headers.find(header => header.line > owner.line)?.line ?? Infinity;
        return allLines.filter(line => line.lineNumber < backgroundEnd || line.lineNumber > owner.line && line.lineNumber < end);
    };
    const owners = headers.filter(header => header.name === scenarioName);
    // .45 may return loaded-not-run state after a completed run. The full result
    // sequence can still identify a single source variant without guessing gaps.
    const matching = owners.length === 1 ? owners : headers.filter(header => {
        const candidate = scope(header); let cursor = 0;
        return ordered.every(text => {
            while (cursor < candidate.length && key(candidate[cursor].text) !== text) { cursor++; }
            return cursor++ < candidate.length;
        });
    });
    const lines = matching.length === 1 ? scope(matching[0]) : allLines;
    const align = (reverse: boolean) => {
        const matches = new Array<number>(ordered.length); let cursor = reverse ? lines.length - 1 : 0;
        for (let index = reverse ? ordered.length - 1 : 0; reverse ? index >= 0 : index < ordered.length; index += reverse ? -1 : 1) {
            while (cursor >= 0 && cursor < lines.length && key(lines[cursor].text) !== ordered[index]) { cursor += reverse ? -1 : 1; }
            if (cursor < 0 || cursor >= lines.length) { return undefined; }
            matches[index] = cursor; cursor += reverse ? -1 : 1;
        }
        return matches;
    };
    const earliest = align(false); const latest = align(true);
    const byText = new Map<string, number[]>();
    for (const [index, line] of lines.entries()) {
        const matches = byText.get(key(line.text));
        if (matches) { matches.push(index); } else { byText.set(key(line.text), [index]); }
    }
    const statuses = new Map<number, VanessaExecutionLine['status']>();
    for (const [index, row] of rows.entries()) {
        const candidates = byText.get(key(row[2]));
        const target = earliest && latest && earliest[index] === latest[index] ? earliest[index] : candidates?.length === 1 ? candidates[0] : undefined;
        if (target === undefined) { continue; }
        const status = row[3] === 'Success' ? 'passed' : row[3] === 'Broken' ? 'stopped' : row[3] === 'Pending' ? 'unknown' : row[3] === 'Skipped' ? 'skipped' : 'failed';
        if (statuses.get(target) !== 'failed') { statuses.set(target, status); }
    }
    const byLine = new Map<number, (VanessaExecutionLine['status'] | undefined)[]>();
    for (const [index, line] of lines.entries()) {
        const values = byLine.get(line.lineNumber) ?? []; values.push(statuses.get(index)); byLine.set(line.lineNumber, values);
    }
    return [...byLine].flatMap(([lineNumber, values]): VanessaExecutionLine[] => {
        // One failed child proves a failed call; success requires every expanded child.
        if (values.includes('failed')) { return [{ lineNumber, status: 'failed' }]; }
        if (values.includes(undefined)) { return []; }
        const status = values.includes('stopped') ? 'stopped' : values.every(value => value === 'passed') ? 'passed'
            : values.every(value => value === 'skipped') ? 'skipped' : 'unknown';
        return [{ lineNumber, status }];
    }).sort((a, b) => a.lineNumber - b.lineNumber);
}
