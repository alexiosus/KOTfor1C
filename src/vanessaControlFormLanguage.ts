import type { BuiltInStepDefinition } from './stepCatalog';

const keyword = /^(\s*(?:\*\s*)?(?:And|Given|When|Then|But|И|Допустим|Дано|Когда|Тогда|Но)\s+)(.*)$/iu;
const placeholder = /(["'])\s*%(\d+)\s+[^"']*?\1/gu;
const strip = (text: string) => text.replace(keyword, '$2');
const fold = (text: string) => text.replace(/\s+/gu, ' ').toLocaleLowerCase();
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s+');
interface Pattern { expression: RegExp; prefix: string; indexes: number[]; target: string }
const cache = new WeakMap<readonly BuiltInStepDefinition[], Map<'en' | 'ru', readonly Pattern[]>>();
function patterns(steps: readonly BuiltInStepDefinition[], language: 'en' | 'ru'): readonly Pattern[] {
    let languages = cache.get(steps); if (!languages) { languages = new Map(); cache.set(steps, languages); }
    const cached = languages.get(language); if (cached) { return cached; }
    const result: Pattern[] = [];
    for (const step of steps) {
        const target = step[language]; if (!target) { continue; }
        for (const source of [step.ru, step.en]) {
            if (!source) { continue; }
            const text = strip(source.pattern.split(/\r?\n/u, 1)[0]);
            const tokens = [...text.matchAll(placeholder)]; let expression = ''; let offset = 0; const indexes: number[] = [];
            for (const token of tokens) {
                expression += literal(text.slice(offset, token.index)) + '("(?:\\\\.|[^"\\\\\\r\\n])*(?:\\\\)?"|\'(?:\\\\.|[^\'\\\\\\r\\n])*(?:\\\\)?\'|[+-]?\\d+(?:[.,]\\d+)?)';
                indexes.push(Number(token[2])); offset = token.index! + token[0].length;
            }
            expression += literal(text.slice(offset));
            result.push({ expression: new RegExp('^' + expression + '$', 'iu'), prefix: fold(text.slice(0, tokens[0]?.index ?? text.length)),
                indexes, target: strip(target.pattern.split(/\r?\n/u, 1)[0]) });
        }
    }
    languages.set(language, result); return result;
}

/** Compatibility for .45 form checks (not recordings): translate only catalog-defined literals. Values, payloads and unknown custom steps stay byte-for-byte intact. */
export function translateVanessaFormSteps(text: string, steps: readonly BuiltInStepDefinition[], language: 'en' | 'ru'): { text: string; untranslated: number } {
    const compiled = patterns(steps, language); let untranslated = 0; let docstring = '';
    const translated = text.split(/\r\n|\r|\n/u).map(line => {
        const fence = /^\s*("""|'''|```)/u.exec(line)?.[1];
        if (fence) { if (!docstring) { docstring = fence; } else if (docstring === fence) { docstring = ''; } return line; }
        if (docstring) { return line; }
        const invocation = keyword.exec(line); if (!invocation) { return line; }
        const body = invocation[2]; const normalized = fold(body); const candidates = new Set<string>();
        for (const pattern of compiled) {
            if (!normalized.startsWith(pattern.prefix)) { continue; }
            const match = pattern.expression.exec(body); if (!match) { continue; }
            const values = new Map<number, string>(); let valid = true;
            for (let position = 0; position < pattern.indexes.length; position++) {
                const index = pattern.indexes[position]; const value = match[position + 1];
                if (values.has(index) && values.get(index) !== value) { valid = false; }
                values.set(index, value);
            }
            const target = pattern.target.replace(placeholder, (token, _quote: string, index: string) => {
                const value = values.get(Number(index)); if (value === undefined) { valid = false; return token; } return value;
            });
            if (valid) { candidates.add(target); }
        }
        if (candidates.size !== 1) { untranslated++; return line; }
        const keywords: Record<string, string> = language === 'en'
            ? { 'и': 'And', 'допустим': 'Given', 'дано': 'Given', 'когда': 'When', 'тогда': 'Then', 'но': 'But' }
            : { and: 'И', given: 'Дано', when: 'Когда', then: 'Тогда', but: 'Но' };
        const prefix = invocation[1].replace(/(And|Given|When|Then|But|И|Допустим|Дано|Когда|Тогда|Но)(\s+)$/iu,
            (_all, word: string, space: string) => (keywords[word.toLocaleLowerCase()] ?? word) + space);
        return prefix + candidates.values().next().value;
    }).join('\n');
    return { text: translated, untranslated };
}
