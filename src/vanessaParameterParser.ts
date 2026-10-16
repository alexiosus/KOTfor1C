export type VanessaParameterValueKind = 'boolean' | 'number' | 'string' | 'array' | 'object' | 'unknown';
export interface VanessaParameterDefinition { key: string; aliases: string[]; value: string; valueKind: VanessaParameterValueKind; description: string }

function functionBody(source: string, name: string): string {
    return new RegExp(`(?:^|\\n)\\s*Функция\\s+${name}\\([^]*?\\n([^]*?)\\n\\s*КонецФункции`, 'iu').exec(source)?.[1] ?? '';
}

/** The release package ships these generated form tooltips even without the BSL sources. */
export function parseVanessaParameterDocumentation(documentation: string): VanessaParameterDefinition[] {
    return [...documentation.matchAll(/\*\s+\*\*([^*{\r\n]+?)(?:\s*\{([^}\r\n]+)\})?\*\*:\s*\r?\n([^]*?)(?=\r?\n\s*(?:\*|#)|$)/gu)].map(match => {
        const key = match[1].trim(); const alias = match[2]?.trim();
        return { key, aliases: alias && alias !== key ? [alias] : [], value: '', valueKind: 'unknown' as const,
            description: match[3].trim().replace(/\s+/gu, ' ') };
    });
}

/** Read declarative insertions only. Never evaluate BSL or expressions from a Vanessa checkout. */
export function parseVanessaParameterSources(objectSource: string, formSource: string, documentation = ''): VanessaParameterDefinition[] {
    const body = functionBody(objectSource, 'СтруктураОбщихНастроек');
    if (!body) { return []; }
    const aliases = new Map<string, string>();
    for (const match of (functionBody(formSource, 'ИменаКлючейОбщихНастроек') || functionBody(formSource, 'ТаблицаИменаКлючейОбщихНастроек')).matchAll(/^\s*ТаблицаИменНоваяСтрока\("([^"\r\n]+)",\s*"([^"\r\n]+)"/gmu)) {
        aliases.set(match[1], match[2]);
    }
    const descriptions = new Map(parseVanessaParameterDocumentation(documentation).map(entry => [entry.key, entry.description]));
    const structures = new Map<string, Array<{ name: string; expression: string }>>();
    for (const line of body.split(/\r?\n/u)) {
        const declaration = /^\s*([\p{L}\w]+)\s*=\s*Новый Структура\s*;/u.exec(line);
        if (declaration) { structures.set(declaration[1], []); }
        const insertion = /^\s*([\p{L}\w]+)\.Вставить\("((?:[^"\r\n]|"")*)"(?:,\s*(.*?))?\);/u.exec(line);
        if (insertion) { structures.get(insertion[1])?.push({ name: insertion[2].replace(/""/gu, '"'), expression: insertion[3]?.trim() ?? '' }); }
    }
    const rows: VanessaParameterDefinition[] = [];
    const walk = (variable: string, parents: string[], ancestors: Set<string>) => {
        if (ancestors.has(variable)) { return; }
        const seen = new Set(ancestors).add(variable);
        for (const { name, expression } of structures.get(variable) ?? []) {
            const parts = [...parents, name]; const key = parts.join('.');
            const english = parts.map(part => aliases.get(part) ?? part).join('.');
            let value = '';
            let valueKind: VanessaParameterValueKind = 'unknown';
            if (/^Истина$/iu.test(expression)) { value = 'true'; valueKind = 'boolean'; }
            else if (/^Ложь$/iu.test(expression)) { value = 'false'; valueKind = 'boolean'; }
            else if (/^-?\d+(?:\.\d+)?$/u.test(expression)) { value = expression; valueKind = 'number'; }
            else if (/^"(?:[^"]|"")*"$/u.test(expression)) { value = expression.slice(1, -1).replace(/""/gu, '"'); valueKind = 'string'; }
            else if (/^Новый Массив$/iu.test(expression)) { value = '[]'; valueKind = 'array'; }
            else if (structures.has(expression) || /^Новый Структура$/iu.test(expression)) { value = '{}'; valueKind = 'object'; }
            rows.push({ key, aliases: english === key ? [] : [english], value, valueKind,
                description: descriptions.get(name) ?? english });
            if (structures.has(expression)) { walk(expression, parts, seen); }
        }
    };
    walk('Настройки', [], new Set());
    return [...new Map(rows.map(row => [row.key, row])).values()];
}
