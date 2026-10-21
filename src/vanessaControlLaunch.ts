import { applyAdditionalVanessaParameters, findObjectKeyByAlias, parseAdditionalParameterPointer, type AdditionalLaunchVanessaParameter, type JsonValue } from './vanessaLaunchJson';
export function withVanessaAuthoringLanguageDefault(value: JsonValue, language: 'en' | 'ru', parameters: readonly AdditionalLaunchVanessaParameter[] = []): JsonValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return value; }
    // This runs after infobase preparation/feature retargeting. Never reapply a
    // profile's connection paths or other values over that resolved target.
    const languageParameters = parameters.filter(parameter => {
        const pointer = parseAdditionalParameterPointer(parameter.key);
        return pointer?.length === 1 && typeof pointer[0] === 'string' &&
            !!findObjectKeyByAlias({ ЯзыкГенератораGherkin: null, Lang: null }, pointer[0]);
    });
    const configured = applyAdditionalVanessaParameters(value, languageParameters).value as Record<string, JsonValue>;
    const key = findObjectKeyByAlias(configured, 'ЯзыкГенератораGherkin');
    const langKey = Object.keys(configured).find(name => name.toLocaleLowerCase() === 'lang');
    const explicit = key ? configured[key] : langKey ? configured[langKey] : undefined;
    const selected = typeof explicit === 'string' && explicit.trim() ? explicit.trim() : language;
    const result = { ...value };
    if (langKey) { delete result[langKey]; }
    // .45 assigns the generator language both from Lang and from the aliased
    // setting. Keep them consistent regardless of their order in the JSON.
    result.Lang = selected;
    result[key ?? 'ЯзыкГенератораGherkin'] = selected;
    return result;
}

export function managedVanessaCommandParts(parts: readonly string[], port: number): string[] {
    if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error('A valid Vanessa MCP port is required.'); }
    if (parts.some(part => /^StartFeaturePlayer(?:=|$)/iu.test(part))) { throw new Error('Managed debug must not start tests automatically.'); }
    return [...parts, ...(parts.includes('UseEditor') ? [] : ['UseEditor']), 'runMcp', `mcpPort=${port}`];
}

/** .45 registers MCP libraries before VanessaExt may have connected successfully. */
export function withVanessaMcpStartupCompatibility(value: JsonValue): JsonValue {
    return applyAdditionalVanessaParameters(value, [{ key: 'ПоискФайловСПомощьюКомпонентыVanessaExt', value: 'false', valueKind: 'boolean', overrideExisting: true }]).value;
}
