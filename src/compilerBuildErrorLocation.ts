import fs from 'node:fs/promises';
import path from 'node:path';
import { ScenarioYamlDocument } from './scenarioYamlDocument';
import { findCompilerScenarioCall, getCompilerScenarioBody, parseCompilerParameterBinding, scanCompilerLines } from './scenarioCompilerSyntax';
import { joinNativeSpprScenario } from './spprScenarioFormat';
import type { CompilerBuildReportSource } from './compilerBuildReport';

interface ErrorLocation { source: CompilerBuildReportSource; line: number }
const stepName = (value: string) => value.trim().replace(/^<(.*)>$/u, '$1').replace(/^(?:And|И|Допустим)\s+/iu, '').replace(/\s+/gu, ' ');

/** Compiler settings UIDs identify the root. Stack coordinates must follow declarations into each nested source. */
export async function resolveCompilerBuildErrorLocation(sources: readonly CompilerBuildReportSource[], root: CompilerBuildReportSource,
    message: string): Promise<ErrorLocation | null> {
    const cache = new Map<string, Promise<{ body: ReturnType<typeof getCompilerScenarioBody>; bodySource: CompilerBuildReportSource;
        children: Map<string, CompilerBuildReportSource>; declared: Set<string> }>>();
    const load = (source: CompilerBuildReportSource) => {
        let pending = cache.get(source.path);
        if (!pending) {
            pending = fs.readFile(source.path, 'utf8').catch(() => '').then(async text => {
                const yaml = ScenarioYamlDocument.parse(text); const children = new Map<string, CompilerBuildReportSource>(); const declared = new Set<string>();
                let body = text && !yaml.errors.length ? getCompilerScenarioBody(text) : null;
                let bodySource = source;
                if (!yaml.errors.length) {
                    for (const entry of yaml.readRecords('ВложенныеСценарии')) {
                        const uid = String(entry.fields.get('UIDВложенныйСценарий') ?? '').trim().toLowerCase();
                        const name = stepName(String(entry.fields.get('ИмяСценария') ?? ''));
                        const matches = uid ? sources.filter(candidate => candidate.uid?.toLowerCase() === uid) : [];
                        if (declared.has(name)) { children.delete(name); continue; }
                        declared.add(name);
                        if (name && matches.length === 1) { children.set(name, matches[0]); }
                    }
                    if (!body && path.basename(source.path) === 'meta.yaml') {
                        try {
                            const scriptPath = path.join(path.dirname(source.path), 'scen.feature');
                            const script = await fs.readFile(scriptPath, 'utf8');
                            const joined = joinNativeSpprScenario(text.endsWith('\n') ? text : text + '\n', script);
                            const nativeBody = getCompilerScenarioBody(joined);
                            if (nativeBody) {
                                body = { ...nativeBody, startLine: 0 };
                                bodySource = { ...source, path: scriptPath };
                            }
                        } catch { /* Invalid metadata or a missing script keeps the metadata fallback. */ }
                    }
                }
                return { body, bodySource, children, declared };
            });
            cache.set(source.path, pending);
        }
        return pending;
    };
    type Frame = { number: number; text: string; indent: number };
    const traces: Frame[][] = []; let trace: Frame[] = [];
    const flushTrace = () => { if (trace.length) { traces.push(trace); trace = []; } };
    for (const line of message.split(/\r\n|\r|\n/u)) {
        const match = /^([ \t]*)(?:---)*Строка\s*№\s*(\d+)\.[ \t]*(.+)$/iu.exec(line);
        if (!match) { flushTrace(); continue; }
        const missingKeyword = /^Не найдено ключевое слово в начале строки\.[ \t]*<(.+)>$/iu.exec(match[3]);
        const frame = { number: Number(match[2]), text: stepName(missingKeyword?.[1] ?? match[3]), indent: match[1].length };
        if (trace.length && frame.indent <= trace[trace.length - 1].indent) { flushTrace(); }
        trace.push(frame);
    }
    flushTrace();
    if (traces.length) {
        const locations: Array<ErrorLocation & { depth: number }> = [];
        // The processing writes stacks root first, indenting each child. Never restart a suffix at the root.
        for (const frames of traces) {
            if (frames[0].indent !== 0) { continue; }
            let current = root;
            for (let index = 0; index < frames.length; index++) {
                const frame = frames[index]; const data = await load(current); const body = data.body;
                if (!body || frame.number < 1 || frame.number > body.lines.length || stepName(body.lines[frame.number - 1]) !== frame.text) { break; }
                if (index === frames.length - 1) {
                    locations.push({ source: data.bodySource, line: body.startLine + frame.number, depth: frames.length });
                    break;
                }
                const child = data.children.get(frame.text);
                if (!child) { break; }
                current = child;
            }
        }
        const depth = Math.max(0, ...locations.map(location => location.depth));
        const unique = [...new Map(locations.filter(location => location.depth === depth).map(location => [`${location.source.path}:${location.line}`, location])).values()];
        if (unique.length === 1) { return { source: unique[0].source, line: unique[0].line }; }
        // A frame from a child must never be guessed against the root's body.
        return null;
    }
    const parameter = /нет параметра с именем\s*<([^>]+)>/iu.exec(message)?.[1];
    const childName = /подсценарии\s*<([^>]+)>/iu.exec(message)?.[1];
    const numbers = [...new Set([...message.matchAll(/(?:Строка\s*№\s*|\bline\s+)(\d+)[.:]/giu)].map(match => Number(match[1])))];
    if (!parameter && !numbers.length) { return null; }
    const queue = [root]; const visited = new Set<string>(); const bindings: ErrorLocation[] = [];
    while (queue.length) {
        const source = queue.shift()!;
        if (visited.has(source.path)) { continue; } visited.add(source.path);
        const { body, bodySource, children, declared } = await load(source);
        queue.push(...children.values());
        if (!body) { continue; }
        if (parameter) {
            const scanned = scanCompilerLines(body.lines);
            body.lines.forEach((text, index) => {
                if (scanned[index].kind === 'code' && parseCompilerParameterBinding(text)?.name === parameter
                    && (!childName || stepName(findCompilerScenarioCall(body.lines, index) ?? '') === stepName(childName))) {
                    bindings.push({ source: bodySource, line: body.startLine + index + 1 });
                }
            });
        } else if (source === root && !declared.size) {
            if (numbers.length === 1 && numbers[0] > 0 && numbers[0] <= body.lines.length) { return { source: bodySource, line: body.startLine + numbers[0] }; }
        }
    }
    return bindings.length === 1 ? bindings[0] : null;
}
