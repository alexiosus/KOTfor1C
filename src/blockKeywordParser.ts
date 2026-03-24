export type BlockKeyword =
    | 'If'
    | 'ElseIf'
    | 'Else'
    | 'EndIf'
    | 'Do'
    | 'EndDo'
    | 'Try'
    | 'Except'
    | 'EndTry'
    | null;

export type BlockKeywordLanguage = 'en' | 'ru';

const OPTIONAL_GHERKIN_PREFIX_REGEX = /^(?:\*\s*)?(?:And|But|Then|When|Given|И|Тогда|Когда|К тому же|Допустим|Дано|Но)\s+/i;
const PREPROCESSOR_KEYWORD_REGEX = /^#(?:если|иначеесли|иначе|конецесли)(?:\s|$)/i;
const IF_OPEN_REGEXES = [
    /^if\b.+\bthen$/i,
    /^(?:#если|если)\s+.+\s+тогда$/i
];
const ELSE_IF_REGEXES = [
    /^elseif\b.+\bthen$/i,
    /^(?:#иначеесли|иначеесли)\s+.+\s+тогда$/i
];
const ELSE_REGEXES = [
    /^else$/i,
    /^(?:#иначе|иначе)$/i
];
const END_IF_REGEXES = [
    /^endif$/i,
    /^(?:#конецесли|конецесли)$/i
];
const DO_OPEN_REGEXES = [
    /^do(?:\s|$)/i,
    /^цикл(?:\s|$)/i,
    /^while\b.+\bthen$/i,
    /^while\b.+\bi do\b.*$/i,
    /^for each\b.+$/i,
    /^for\b.+\bi do\b.*$/i,
    /^i repeat\b.+\btimes$/i,
    /^i open required list form for each line\b.+$/i,
    /^пока\s+.+\s+тогда$/i,
    /^пока\s+.+\s+я выполняю(?:\s.+)?$/i,
    /^(?:для|в течение)\s+.+\s+я выполняю(?:\s.+)?$/i,
    /^(?:для каждого|для каждой)\s+.+$/i,
    /^я делаю\s+.+\s+раз$/i
];
const END_DO_REGEX = /^(?:конеццикла|enddo)$/i;
const TRY_REGEX = /^(?:попытка|try)$/i;
const EXCEPT_REGEX = /^(?:исключение|except)$/i;
const END_TRY_REGEX = /^(?:конецпопытки|endtry)$/i;

function normalizeBlockLine(line: string): string {
    const normalizedLines = line
        .split(/\r?\n/)
        .map(part => part.trim())
        .filter(Boolean);
    const firstLine = normalizedLines[0] ?? '';
    if (!firstLine) {
        return '';
    }

    if (firstLine.startsWith('#') && !PREPROCESSOR_KEYWORD_REGEX.test(firstLine)) {
        return '';
    }

    const withoutKeyword = firstLine.replace(OPTIONAL_GHERKIN_PREFIX_REGEX, '');
    return withoutKeyword
        .replace(/\s+/g, ' ')
        .replace(/\s*:\s*$/, '')
        .trim();
}

export function parseBlockKeyword(line: string): BlockKeyword {
    const normalized = normalizeBlockLine(line);
    if (!normalized) {
        return null;
    }

    if (END_IF_REGEXES.some(regex => regex.test(normalized))) {
        return 'EndIf';
    }
    if (END_DO_REGEX.test(normalized)) {
        return 'EndDo';
    }
    if (END_TRY_REGEX.test(normalized)) {
        return 'EndTry';
    }
    if (ELSE_IF_REGEXES.some(regex => regex.test(normalized))) {
        return 'ElseIf';
    }
    if (ELSE_REGEXES.some(regex => regex.test(normalized))) {
        return 'Else';
    }
    if (TRY_REGEX.test(normalized)) {
        return 'Try';
    }
    if (EXCEPT_REGEX.test(normalized)) {
        return 'Except';
    }
    if (IF_OPEN_REGEXES.some(regex => regex.test(normalized))) {
        return 'If';
    }
    if (DO_OPEN_REGEXES.some(regex => regex.test(normalized))) {
        return 'Do';
    }

    return null;
}

export function getBlockClosingKeyword(
    blockKeyword: BlockKeyword,
    language: BlockKeywordLanguage
): string | null {
    if (blockKeyword === 'If') {
        return language === 'ru' ? 'КонецЕсли' : 'EndIf';
    }

    if (blockKeyword === 'Do') {
        return language === 'ru' ? 'КонецЦикла' : 'EndDo';
    }

    if (blockKeyword === 'Try') {
        return language === 'ru' ? 'КонецПопытки' : 'EndTry';
    }

    return null;
}
