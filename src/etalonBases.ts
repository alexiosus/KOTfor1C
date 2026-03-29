import * as fs from 'node:fs';
import * as path from 'node:path';
import { isHostAccessibleFileInfobasePath, isWindowsAbsolutePath } from './oneCInfobaseConnection';

export interface BuildParameterLike {
    key: string;
    value: string;
}

export interface EtalonBaseUserProfile {
    profileName: string;
    login: string;
    password: string;
}

export interface EtalonBaseDefinition {
    name: string;
    databaseId: string;
    dtFilePath: string;
    userProfiles: EtalonBaseUserProfile[];
}

const DEFAULT_MODEL_DB_SETTINGS_RELATIVE_PATH = '.vscode/kot-runtime/bases.yaml';

function escapeYamlDoubleQuotedString(value: string): string {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
}

function normalizeYamlIndent(line: string): string {
    return line.replace(/^\t+/, tabs => '    '.repeat(tabs.length));
}

function getYamlIndent(line: string): number {
    const normalized = normalizeYamlIndent(line);
    const match = normalized.match(/^(\s*)/);
    return match ? match[1].length : 0;
}

function isIgnorableYamlLine(line: string): boolean {
    const trimmed = line.replace(/^\uFEFF/, '').trim();
    return trimmed.length === 0 || trimmed.startsWith('#');
}

function isYamlKeyLine(trimmedNoBom: string): boolean {
    return /^[^:#][^:]*:\s*(.*)$/.test(trimmedNoBom);
}

function findYamlSectionEnd(lines: string[], startIndex: number, startIndent: number): number {
    for (let index = startIndex + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (isIgnorableYamlLine(line)) {
            continue;
        }

        const indent = getYamlIndent(line);
        const trimmedNoBom = line.replace(/^\uFEFF/, '').trim();
        if (indent <= startIndent && isYamlKeyLine(trimmedNoBom)) {
            return index;
        }
    }

    return lines.length;
}

function parseYamlScalar(rawValue: string): string {
    const trimmed = String(rawValue ?? '').trim();
    if (!trimmed) {
        return '';
    }

    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
    ) {
        const quote = trimmed[0];
        const inner = trimmed.slice(1, -1);
        if (quote === '"') {
            return inner
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\');
        }
        return inner;
    }

    return trimmed;
}

function parseYamlFieldValue(line: string, fieldName: string): string | null {
    const match = line.match(new RegExp(`^\\s*${fieldName}:\\s*(.*)$`));
    if (!match) {
        return null;
    }

    return parseYamlScalar(match[1] || '');
}

function parseEtalonBaseUserProfiles(lines: string[], sectionStart: number, sectionEnd: number): EtalonBaseUserProfile[] {
    const userProfiles: EtalonBaseUserProfile[] = [];
    let profilesSectionStart = -1;

    for (let index = sectionStart; index < sectionEnd; index += 1) {
        const line = lines[index];
        const trimmedLine = line.replace(/^\uFEFF/, '').trim();
        if (trimmedLine === 'ПрофилиПользователей:' || trimmedLine === 'ПрофилиПользователей: []') {
            profilesSectionStart = index;
            break;
        }
    }

    if (profilesSectionStart === -1) {
        return userProfiles;
    }

    const profilesIndent = getYamlIndent(lines[profilesSectionStart]);
    let index = profilesSectionStart + 1;
    while (index < sectionEnd) {
        const line = lines[index];
        if (isIgnorableYamlLine(line)) {
            index += 1;
            continue;
        }

        const indent = getYamlIndent(line);
        if (indent <= profilesIndent) {
            break;
        }

        if (!/^\s*-\s*[^:]+:\s*$/.test(line)) {
            index += 1;
            continue;
        }

        const profileItemIndent = indent;
        let profileEnd = index + 1;
        while (profileEnd < sectionEnd) {
            const nextLine = lines[profileEnd];
            if (isIgnorableYamlLine(nextLine)) {
                profileEnd += 1;
                continue;
            }

            const nextIndent = getYamlIndent(nextLine);
            if (nextIndent <= profilesIndent) {
                break;
            }
            if (nextIndent === profileItemIndent && /^\s*-\s*[^:]+:\s*$/.test(nextLine)) {
                break;
            }
            profileEnd += 1;
        }

        const profile: EtalonBaseUserProfile = {
            profileName: '',
            login: '',
            password: ''
        };

        for (let cursor = index + 1; cursor < profileEnd; cursor += 1) {
            const rawLine = lines[cursor];
            const parsedProfileName = parseYamlFieldValue(rawLine, 'ПрофильПользователя');
            if (parsedProfileName !== null) {
                profile.profileName = parsedProfileName;
                continue;
            }

            const parsedLogin = parseYamlFieldValue(rawLine, 'Логин');
            if (parsedLogin !== null) {
                profile.login = parsedLogin;
                continue;
            }

            const parsedPassword = parseYamlFieldValue(rawLine, 'Пароль');
            if (parsedPassword !== null) {
                profile.password = parsedPassword;
            }
        }

        if (profile.profileName.trim()) {
            userProfiles.push(profile);
        }

        index = profileEnd;
    }

    return userProfiles;
}

export function getDefaultModelDbSettingsValue(): string {
    return DEFAULT_MODEL_DB_SETTINGS_RELATIVE_PATH;
}

export function normalizeBuildParameterKey(key: string): string {
    return String(key ?? '').trim().toLowerCase().replace(/[_\-\s]/g, '');
}

export function getConfiguredModelDbSettingsValue(parameters: BuildParameterLike[]): string {
    const parameter = parameters.find(item => normalizeBuildParameterKey(item.key) === 'modeldbsettings');
    const value = String(parameter?.value ?? '').trim();
    return value || getDefaultModelDbSettingsValue();
}

export function resolveEtalonBasesFilePath(workspaceRootPath: string, configuredValue: string): string {
    const trimmedValue = String(configuredValue ?? '').trim() || getDefaultModelDbSettingsValue();
    if (path.isAbsolute(trimmedValue) || isWindowsAbsolutePath(trimmedValue)) {
        return trimmedValue;
    }

    return path.resolve(workspaceRootPath, trimmedValue);
}

export function resolveModelDbSettingsFilePathFromParameters(
    workspaceRootPath: string,
    parameters: BuildParameterLike[]
): string {
    return resolveEtalonBasesFilePath(
        workspaceRootPath,
        getConfiguredModelDbSettingsValue(parameters)
    );
}

export function resolveEtalonBaseDtFilePath(modelDbSettingsFilePath: string, rawDtFilePath: string): string {
    const trimmedValue = String(rawDtFilePath ?? '').trim();
    if (!trimmedValue) {
        return '';
    }

    if (path.isAbsolute(trimmedValue) || isWindowsAbsolutePath(trimmedValue)) {
        return trimmedValue;
    }

    return path.resolve(path.dirname(modelDbSettingsFilePath), trimmedValue);
}

export function canUseEtalonBaseDtFileAsDefaultUri(dtFilePath: string): boolean {
    const trimmedValue = String(dtFilePath ?? '').trim();
    return Boolean(trimmedValue) && isHostAccessibleFileInfobasePath(trimmedValue);
}

export function findEtalonBaseByIdOrName(
    bases: EtalonBaseDefinition[],
    identifierOrName: string
): EtalonBaseDefinition | undefined {
    const normalizedQuery = String(identifierOrName ?? '').trim().toLocaleLowerCase();
    if (!normalizedQuery) {
        return undefined;
    }

    return bases.find(base =>
        base.databaseId.trim().toLocaleLowerCase() === normalizedQuery
        || base.name.trim().toLocaleLowerCase() === normalizedQuery
    );
}

export function parseEtalonBasesYaml(text: string): EtalonBaseDefinition[] {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    let sectionStart = -1;

    for (let index = 0; index < lines.length; index += 1) {
        const trimmedNoBom = lines[index].replace(/^\uFEFF/, '').trim();
        if (getYamlIndent(lines[index]) === 0 && trimmedNoBom === 'ЭталонныеБД:') {
            sectionStart = index;
            break;
        }
    }

    if (sectionStart === -1) {
        return [];
    }

    const sectionIndent = getYamlIndent(lines[sectionStart]);
    const sectionEnd = findYamlSectionEnd(lines, sectionStart, sectionIndent);
    const bases: EtalonBaseDefinition[] = [];

    let index = sectionStart + 1;
    while (index < sectionEnd) {
        const line = lines[index];
        if (isIgnorableYamlLine(line)) {
            index += 1;
            continue;
        }

        const indent = getYamlIndent(line);
        if (indent <= sectionIndent) {
            break;
        }

        if (!/^\s*-\s*[^:]+:\s*$/.test(line)) {
            index += 1;
            continue;
        }

        const itemIndent = indent;
        let itemEnd = index + 1;
        while (itemEnd < sectionEnd) {
            const nextLine = lines[itemEnd];
            if (isIgnorableYamlLine(nextLine)) {
                itemEnd += 1;
                continue;
            }

            const nextIndent = getYamlIndent(nextLine);
            if (nextIndent <= sectionIndent) {
                break;
            }
            if (nextIndent === itemIndent && /^\s*-\s*[^:]+:\s*$/.test(nextLine)) {
                break;
            }
            itemEnd += 1;
        }

        const base: EtalonBaseDefinition = {
            name: '',
            databaseId: '',
            dtFilePath: '',
            userProfiles: parseEtalonBaseUserProfiles(lines, index + 1, itemEnd)
        };

        for (let cursor = index + 1; cursor < itemEnd; cursor += 1) {
            const rawLine = lines[cursor];
            const parsedName = parseYamlFieldValue(rawLine, 'Наименование');
            if (parsedName !== null) {
                base.name = parsedName;
                continue;
            }

            const parsedDtPath = parseYamlFieldValue(rawLine, 'ПутьКФайлуВыгрузки');
            if (parsedDtPath !== null) {
                base.dtFilePath = parsedDtPath;
                continue;
            }

            const parsedDatabaseId = parseYamlFieldValue(rawLine, 'ИдентификаторБазы');
            if (parsedDatabaseId !== null) {
                base.databaseId = parsedDatabaseId;
            }
        }

        if (base.name.trim() || base.databaseId.trim() || base.userProfiles.length > 0 || base.dtFilePath.trim()) {
            bases.push(base);
        }

        index = itemEnd;
    }

    return bases;
}

export function stringifyEtalonBasesYaml(bases: EtalonBaseDefinition[]): string {
    const lines: string[] = ['ЭталонныеБД:'];

    bases.forEach((base, baseIndex) => {
        lines.push(`    - ЭталонныеБД${baseIndex + 1}:`);
        lines.push(`        Наименование: "${escapeYamlDoubleQuotedString(base.name)}"`);
        lines.push(`        ПутьКФайлуВыгрузки: "${escapeYamlDoubleQuotedString(base.dtFilePath)}"`);
        lines.push(`        ИдентификаторБазы: "${escapeYamlDoubleQuotedString(base.databaseId)}"`);
        if (base.userProfiles.length === 0) {
            lines.push('        ПрофилиПользователей: []');
            return;
        }

        lines.push('        ПрофилиПользователей:');
        base.userProfiles.forEach((profile, profileIndex) => {
            lines.push(`            - ПрофилиПользователей${profileIndex + 1}:`);
            lines.push(`                ПрофильПользователя: "${escapeYamlDoubleQuotedString(profile.profileName)}"`);
            lines.push(`                Логин: "${escapeYamlDoubleQuotedString(profile.login)}"`);
            lines.push(`                Пароль: "${escapeYamlDoubleQuotedString(profile.password)}"`);
        });
    });

    return `${lines.join('\n')}\n`;
}

export async function loadEtalonBasesFromFile(filePath: string): Promise<EtalonBaseDefinition[]> {
    try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        return parseEtalonBasesYaml(content);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

export async function saveEtalonBasesToFile(filePath: string, bases: EtalonBaseDefinition[]): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, stringifyEtalonBasesYaml(bases), 'utf-8');
}
