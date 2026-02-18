import * as vscode from 'vscode';
import { parse } from 'node-html-parser';
import { getStepsHtml, forceRefreshSteps as forceRefreshStepsCore } from './stepsFetcher';
import { getTranslator } from './localization';
import * as path from 'path';
import { TestInfo } from './types';

// Интерфейс для хранения определений шагов и их описаний
interface StepDefinition {
    pattern: string;      // Оригинальный шаблон с плейсхолдерами
    firstLine: string;    // Только первая строка шаблона
    segments: string[];   // Шаблон, разбитый на сегменты между плейсхолдерами
    description: string;  // Описание шага
    startsWithPlaceholder: boolean;
    // Новые поля для мультиязычности
    russianPattern?: string;      // Русский шаблон
    russianFirstLine?: string;    // Первая строка русского шаблона
    russianSegments?: string[];   // Сегменты русского шаблона
    russianDescription?: string;  // Русское описание
    russianStartsWithPlaceholder?: boolean;
}

const PLACEHOLDER_REGEX = /"%\d+\s+[^"]*"|'%\d+\s+[^']*'/g;
const STEP_LITERAL_REGEX = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\[[A-Za-zА-Яа-яЁё0-9_-]+\]/g;

interface ScenarioCacheProvider {
    getTestCache(): Map<string, TestInfo> | null;
}

interface ScenarioDescriptionInfo {
    hasKotMetadata: boolean;
    description: string;
}

interface ScenarioHoverCachedData {
    filesCount: number;
    descriptionInfo: ScenarioDescriptionInfo;
    expiresAt: number;
}

export class DriveHoverProvider implements vscode.HoverProvider {
    private stepDefinitions: StepDefinition[] = [];
    private readonly templateRegexCache = new Map<string, RegExp>();
    private isLoading: boolean = false;
    private loadingPromise: Promise<void> | null = null;
    private context: vscode.ExtensionContext;
    private readonly scenarioHoverCache = new Map<string, ScenarioHoverCachedData>();
    private readonly scenarioHoverCacheTtlMs = 8000;
    private hoverTranslator: ((message: string, ...args: string[]) => string) | null = null;
    private hoverTranslatorLanguageOverride: string | null = null;

    constructor(context: vscode.ExtensionContext, private readonly scenarioCacheProvider?: ScenarioCacheProvider) {
        this.context = context;
        // Загружаем определения асинхронно, не блокируя конструктор
        this.loadStepDefinitions().catch(err => {
            console.error("[DriveHoverProvider] Initial load failed on constructor:", err.message);
        });

        this.context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument(document => {
                this.scenarioHoverCache.delete(document.uri.toString());
            }),
            vscode.workspace.onDidCreateFiles(() => {
                this.scenarioHoverCache.clear();
            }),
            vscode.workspace.onDidDeleteFiles(() => {
                this.scenarioHoverCache.clear();
            }),
            vscode.workspace.onDidRenameFiles(() => {
                this.scenarioHoverCache.clear();
            }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('kotTestToolkit.localization.languageOverride')) {
                    this.hoverTranslator = null;
                    this.hoverTranslatorLanguageOverride = null;
                }
            })
        );
    }

    /**
     * Гарантирует, что библиотека шагов загружена.
     */
    public async ensureStepDefinitionsLoaded(): Promise<void> {
        if (this.isLoading && this.loadingPromise) {
            await this.loadingPromise;
            return;
        }
        if (this.stepDefinitions.length === 0 && !this.isLoading) {
            await this.loadStepDefinitions();
        }
    }

    /**
     * Проверяет, известен ли шаг по текущей библиотеке шагов.
     */
    public async isKnownStepLine(lineText: string): Promise<boolean> {
        await this.ensureStepDefinitionsLoaded();
        const trimmed = lineText.trim();
        if (!trimmed) {
            return false;
        }
        return this.stepDefinitions.some(stepDef => {
            try {
                return this.matchLineToPattern(trimmed, stepDef);
            } catch {
                return false;
            }
        });
    }

    /**
     * Подбирает ближайшие варианты шагов для текущей строки.
     */
    public async getStepSuggestions(lineText: string, maxSuggestions: number = 3): Promise<string[]> {
        await this.ensureStepDefinitionsLoaded();
        const inputNormalized = this.normalizeForSuggestion(lineText);
        if (!inputNormalized) {
            return [];
        }

        const scoredCandidates = new Map<string, number>();

        for (const stepDef of this.stepDefinitions) {
            const candidates: string[] = [stepDef.firstLine];
            if (stepDef.russianFirstLine) {
                candidates.push(stepDef.russianFirstLine);
            }

            for (const candidate of candidates) {
                const normalizedCandidate = this.normalizeForSuggestion(candidate);
                if (!normalizedCandidate) {
                    continue;
                }
                const score = this.calculateSimilarity(inputNormalized, normalizedCandidate);
                const existingScore = scoredCandidates.get(candidate);
                if (existingScore === undefined || score > existingScore) {
                    scoredCandidates.set(candidate, score);
                }
            }
        }

        return Array.from(scoredCandidates.entries())
            .filter(([, score]) => score >= 0.25)
            .sort((a, b) => b[1] - a[1])
            .slice(0, Math.max(1, maxSuggestions))
            .map(([candidate]) => candidate);
    }

    // Метод для принудительного обновления
    public async refreshSteps(): Promise<void> {
        console.log("[DriveHoverProvider] Refreshing steps triggered...");
        this.isLoading = true; // Устанавливаем флаг загрузки
        this.loadingPromise = forceRefreshStepsCore(this.context)
            .then(htmlContent => {
                this.parseAndStoreStepDefinitions(htmlContent);
                console.log("[DriveHoverProvider] Steps refreshed and re-parsed successfully for hover.");
            })
            .catch(async (error: any) => { // async здесь
                console.error(`[DriveHoverProvider] Failed to refresh steps: ${error.message}`);
                const t = await getTranslator(this.context.extensionUri);
                vscode.window.showWarningMessage(t('Error updating hints: {0}. Attempting to load from backup sources.', error.message));
                try {
                    const fallbackHtml = await getStepsHtml(this.context, false); // false - не принудительно
                    this.parseAndStoreStepDefinitions(fallbackHtml);
                } catch (fallbackError: any) {
                    console.error(`[DriveHoverProvider] Fallback load also failed: ${fallbackError.message}`);
                    this.stepDefinitions = [];
                }
            })
            .finally(() => {
                this.isLoading = false;
            });
        await this.loadingPromise; // Дожидаемся завершения промиса обновления
    }
    
    private parseAndStoreStepDefinitions(htmlContent: string): void {
        this.stepDefinitions = []; // Очищаем перед заполнением
        this.templateRegexCache.clear();
        if (!htmlContent) {
            console.warn("[DriveHoverProvider] HTML content is null or empty, cannot parse step definitions.");
            return;
        }
        try {
            const root = parse(htmlContent);
            const rows = root.querySelectorAll('tr');
            
            rows.forEach(row => {
                const rowClass = row.classNames;
                if (!rowClass || !rowClass.startsWith('R')) {
                    return;
                }
                
                const cells = row.querySelectorAll('td');
                if (cells.length < 4) {
                    return;
                }

                // Структура: колонки 1-2 русские, колонки 3-4 английские
                const russianStepPattern = cells[0].textContent.trim();
                const russianStepDescription = cells[1].textContent.trim();
                const englishStepPattern = cells[2].textContent.trim();
                const englishStepDescription = cells[3].textContent.trim();

                // Предпочитаем единое определение с английским как primary и русским как secondary.
                if (englishStepPattern) {
                    const englishStepDef = this.createStepDefinition(englishStepPattern, englishStepDescription);

                    if (russianStepPattern && russianStepPattern !== englishStepPattern) {
                        const russianData = this.createStepDefinition(russianStepPattern, russianStepDescription);
                        Object.assign(englishStepDef, {
                            russianPattern: russianData.pattern,
                            russianFirstLine: russianData.firstLine,
                            russianSegments: russianData.segments,
                            russianDescription: russianData.description,
                            russianStartsWithPlaceholder: russianData.startsWithPlaceholder
                        });
                    }

                    this.stepDefinitions.push(englishStepDef);
                    return;
                }

                // Fallback для шагов, где доступна только русская колонка.
                if (russianStepPattern) {
                    this.stepDefinitions.push(this.createStepDefinition(russianStepPattern, russianStepDescription));
                }
            });
            console.log(`[DriveHoverProvider] Parsed and stored ${this.stepDefinitions.length} step definitions.`);
        } catch (e) {
            console.error("[DriveHoverProvider] Error parsing HTML for step definitions:", e);
            this.stepDefinitions = [];
        }
    }

    private loadStepDefinitions(): Promise<void> {
        if (this.isLoading && this.loadingPromise) {
            return this.loadingPromise;
        }
        if (this.stepDefinitions.length > 0 && !this.isLoading) {
            return Promise.resolve();
        }
        
        this.isLoading = true;
        console.log("[DriveHoverProvider] Starting to load step definitions...");
        
        this.loadingPromise = getStepsHtml(this.context)
            .then(htmlContent => {
                this.parseAndStoreStepDefinitions(htmlContent);
            })
            .catch(async error => {
                console.error(`[DriveHoverProvider] Ошибка загрузки steps.htm для подсказок: ${error.message}`);
                const t = await getTranslator(this.context.extensionUri);
                vscode.window.showWarningMessage(t('Error updating hints: {0}. Attempting to load from backup sources.', error.message));
                this.stepDefinitions = [];
            })
            .finally(() => {
                this.isLoading = false;
                console.log("[DriveHoverProvider] Finished loading attempt for step definitions.");
            });
            
        return this.loadingPromise;
    }

    private createStepDefinition(pattern: string, description: string) {
        try {
            // Получаем только первую строку шаблона
            const lines = pattern.split(/\r?\n/);
            const firstLineOriginal = lines[0].trim();
            let cleanedPattern = pattern.replace(/\r?\n\s*/g, ' ').trim();
            
            const gherkinKeywords = /^(?:And|But|Then|When|Given|If|Но|Тогда|Когда|Если|И|К тому же|Допустим)\s+/i;
            const firstLineWithoutKeywords = firstLineOriginal.replace(gherkinKeywords, '');

            const placeholderRegex = PLACEHOLDER_REGEX;
            
            // Заменяем каждый плейсхолдер уникальным маркером
            const markerPrefix = '__PLACEHOLDER_';
            let tempPattern = firstLineOriginal; // Используем оригинальную первую строку для сегментов
            let placeholderCount = 0; 
            
            // Проверяем, начинается ли строка (без Gherkin-ключевых слов) с плейсхолдера
            const startsWithPlaceholder = placeholderRegex.test(firstLineWithoutKeywords) && firstLineWithoutKeywords.match(placeholderRegex)!.index === 0;

            tempPattern = tempPattern.replace(placeholderRegex, () => {
                placeholderCount++;
                return `${markerPrefix}${placeholderCount}__`;
            });
            
            // Разбиваем шаблон по маркерам
            const segments = tempPattern.split(new RegExp(`${markerPrefix}\\d+__`));
            
            // Сохраняем сегменты шаблона для сопоставления
            return {
                pattern: cleanedPattern,
                firstLine: firstLineOriginal, // Сохраняем оригинальную первую строку
                segments,
                description,
                startsWithPlaceholder // Сохраняем флаг
            };
        } catch (error) {
            console.error(`[DriveHoverProvider] Ошибка обработки шаблона "${pattern}": ${error}`);
            return {
                pattern: pattern,
                firstLine: pattern,
                segments: [],
                description: description,
                startsWithPlaceholder: false
            };
        }
    }

    private createRussianStepDefinition(pattern: string, description: string) {
        try {
            const lines = pattern.split(/\r?\n/);
            const firstLineOriginal = lines[0].trim();
            let cleanedPattern = pattern.replace(/\r?\n\s*/g, ' ').trim();

            const gherkinKeywords = /^(?:And|But|Then|When|Given|If|Но|Тогда|Когда|Если|И|К тому же|Допустим)\s+/i;
            const firstLineWithoutKeywords = firstLineOriginal.replace(gherkinKeywords, '');

            const placeholderRegex = PLACEHOLDER_REGEX;
            
            // Заменяем каждый плейсхолдер уникальным маркером
            const markerPrefix = '__PLACEHOLDER_';
            let tempPattern = firstLineOriginal; // Используем оригинальную первую строку для сегментов
            let placeholderCount = 0; 
            
            // Проверяем, начинается ли строка (без Gherkin-ключевых слов) с плейсхолдера
            const startsWithPlaceholder = placeholderRegex.test(firstLineWithoutKeywords) && firstLineWithoutKeywords.match(placeholderRegex)!.index === 0;

            tempPattern = tempPattern.replace(placeholderRegex, () => {
                placeholderCount++;
                return `${markerPrefix}${placeholderCount}__`;
            });
            
            // Разбиваем шаблон по маркерам
            const segments = tempPattern.split(new RegExp(`${markerPrefix}\\d+__`));
            
            return {
                russianPattern: cleanedPattern,
                russianFirstLine: firstLineOriginal,
                russianSegments: segments,
                russianDescription: description,
                russianStartsWithPlaceholder: startsWithPlaceholder
            };
        } catch (error) {
            console.error(`[DriveHoverProvider] Ошибка обработки русского шаблона "${pattern}": ${error}`);
            return {};
        }
    }

    private stripGherkinKeyword(text: string): string {
        const gherkinKeywords = /^(?:And|But|Then|When|Given|If|Но|Тогда|Когда|Если|И|К тому же|Допустим)\s+/i;
        return text.trim().replace(gherkinKeywords, '').trim();
    }

    private escapeRegex(text: string): string {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private getTemplateRegex(template: string): RegExp {
        const normalizedTemplate = this.stripGherkinKeyword(template);
        const cachedRegex = this.templateRegexCache.get(normalizedTemplate);
        if (cachedRegex) {
            return cachedRegex;
        }

        const placeholderToken = '__PLACEHOLDER_TOKEN__';
        const templateWithToken = normalizedTemplate.replace(PLACEHOLDER_REGEX, placeholderToken);
        const escapedTemplate = this.escapeRegex(templateWithToken);
        const regexPattern = escapedTemplate
            .replace(
                new RegExp(placeholderToken, 'g'),
                '(?:"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|\\[[A-Za-zА-Яа-яЁё0-9_-]+\\])'
            )
            .replace(/\s+/g, '\\s+');

        const regex = new RegExp(`^${regexPattern}$`, 'i');
        this.templateRegexCache.set(normalizedTemplate, regex);
        return regex;
    }

    private doesLineMatchTemplate(line: string, template: string): boolean {
        const normalizedLine = this.stripGherkinKeyword(line);
        if (!normalizedLine) {
            return false;
        }
        const regex = this.getTemplateRegex(template);
        return regex.test(normalizedLine);
    }

    private extractStepArgumentLiterals(line: string): string[] {
        const literals: string[] = [];
        let match: RegExpExecArray | null;
        const regex = new RegExp(STEP_LITERAL_REGEX.source, 'g');
        while ((match = regex.exec(line)) !== null) {
            literals.push(match[0]);
        }
        return literals;
    }

    private applyLineLiteralsToTemplate(template: string, literals: string[]): string {
        let literalIndex = 0;
        return template.replace(PLACEHOLDER_REGEX, (placeholder) => {
            if (literalIndex < literals.length) {
                return literals[literalIndex++];
            }
            return placeholder;
        });
    }
    
    private matchLineToPattern(line: string, stepDef: StepDefinition): boolean {
        if (this.doesLineMatchTemplate(line, stepDef.firstLine)) {
            return true;
        }
        if (stepDef.russianFirstLine && this.doesLineMatchTemplate(line, stepDef.russianFirstLine)) {
            return true;
        }
        return false;
    }

    private parseScenarioCallNameFromLine(lineText: string): string | null {
        const match = lineText.match(/^\s*(And|И|Допустим)\s+(.+)$/i);
        if (!match || !match[2]) {
            return null;
        }

        // Strip inline comment tail (if any), then normalize.
        const rawName = match[2].replace(/\s+#.*$/, '').trim();
        if (!rawName || rawName.includes('"') || rawName.includes("'")) {
            return null;
        }

        return rawName;
    }

    private parseScenarioDescription(documentText: string): ScenarioDescriptionInfo {
        const lines = documentText.split(/\r\n|\r|\n/);
        let metadataStart = -1;

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            if (line.trim() === 'KOTМетаданные:' && this.getIndent(line) === 0) {
                metadataStart = lineIndex;
                break;
            }
        }

        if (metadataStart === -1) {
            return { hasKotMetadata: false, description: '' };
        }

        let metadataEnd = lines.length;
        for (let lineIndex = metadataStart + 1; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            const trimmed = line.trim();
            if (trimmed.length === 0 || trimmed.startsWith('#')) {
                continue;
            }
            if (this.getIndent(line) === 0 && /^[^:#][^:]*:\s*/.test(trimmed)) {
                metadataEnd = lineIndex;
                break;
            }
        }

        for (let lineIndex = metadataStart + 1; lineIndex < metadataEnd; lineIndex++) {
            const line = lines[lineIndex];
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                continue;
            }

            const descriptionMatch = trimmed.match(/^Описание:\s*(.*)$/);
            if (!descriptionMatch) {
                continue;
            }

            const rawValue = (descriptionMatch[1] || '').trim();
            const descriptionIndent = this.getIndent(line);

            if (rawValue.startsWith('|') || rawValue.startsWith('>')) {
                const contentLines: string[] = [];
                for (let bodyLineIndex = lineIndex + 1; bodyLineIndex < metadataEnd; bodyLineIndex++) {
                    const bodyLine = lines[bodyLineIndex];
                    const bodyIndent = this.getIndent(bodyLine);
                    const bodyTrimmed = bodyLine.trim();

                    if (bodyTrimmed.length > 0 && bodyIndent <= descriptionIndent) {
                        break;
                    }

                    if (bodyLine.length <= descriptionIndent) {
                        contentLines.push('');
                        continue;
                    }

                    const unindented = bodyLine.slice(descriptionIndent + 1);
                    contentLines.push(unindented);
                }

                return {
                    hasKotMetadata: true,
                    description: this.normalizeKotDescriptionContent(contentLines.join('\n'))
                };
            }

            return {
                hasKotMetadata: true,
                description: this.normalizeKotDescriptionContent(this.parseInlineYamlScalar(rawValue))
            };
        }

        return { hasKotMetadata: true, description: '' };
    }

    private getIndent(line: string): number {
        const normalized = line.replace(/^\t+/, tabs => '    '.repeat(tabs.length));
        return (normalized.match(/^(\s*)/) || [''])[0].length;
    }

    private parseInlineYamlScalar(rawValue: string): string {
        const trimmed = rawValue.trim();
        if (!trimmed) {
            return '';
        }

        if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
            return trimmed.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
        }

        if (trimmed.length >= 2 && trimmed.startsWith('\'') && trimmed.endsWith('\'')) {
            return trimmed.slice(1, -1).replace(/''/g, '\'');
        }

        return trimmed;
    }

    private normalizeKotDescriptionContent(rawValue: string): string {
        const trimmed = rawValue.trim();
        if (!trimmed) {
            return '';
        }

        const nonEmptyLines = trimmed
            .split(/\r\n|\r|\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0);

        if (nonEmptyLines.length > 0 && nonEmptyLines.every(line => line === '-')) {
            return '';
        }

        return trimmed;
    }

    private async getScenarioDescriptionInfo(uri: vscode.Uri): Promise<ScenarioDescriptionInfo> {
        const openDoc = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
        if (openDoc) {
            return this.parseScenarioDescription(openDoc.getText());
        }

        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(bytes).toString('utf-8');
            return this.parseScenarioDescription(text);
        } catch {
            return { hasKotMetadata: false, description: '' };
        }
    }

    private async countFilesInScenarioFilesFolder(uri: vscode.Uri): Promise<number> {
        const scenarioDirUri = vscode.Uri.file(path.dirname(uri.fsPath));
        const filesDirUri = vscode.Uri.joinPath(scenarioDirUri, 'files');

        try {
            await vscode.workspace.fs.stat(filesDirUri);
        } catch {
            return 0;
        }

        let count = 0;
        const stack: vscode.Uri[] = [filesDirUri];

        while (stack.length > 0) {
            const currentDir = stack.pop()!;
            let entries: [string, vscode.FileType][];
            try {
                entries = await vscode.workspace.fs.readDirectory(currentDir);
            } catch {
                continue;
            }

            for (const [name, type] of entries) {
                if (type === vscode.FileType.File) {
                    count++;
                    continue;
                }
                if (type === vscode.FileType.Directory) {
                    stack.push(vscode.Uri.joinPath(currentDir, name));
                }
            }
        }

        return count;
    }

    private async getScenarioHoverCachedData(testInfo: TestInfo): Promise<ScenarioHoverCachedData> {
        const key = testInfo.yamlFileUri.toString();
        const now = Date.now();
        const cached = this.scenarioHoverCache.get(key);
        if (cached && cached.expiresAt > now) {
            return cached;
        }

        const [descriptionInfo, filesCount] = await Promise.all([
            this.getScenarioDescriptionInfo(testInfo.yamlFileUri),
            this.countFilesInScenarioFilesFolder(testInfo.yamlFileUri)
        ]);

        const refreshed: ScenarioHoverCachedData = {
            filesCount,
            descriptionInfo,
            expiresAt: now + this.scenarioHoverCacheTtlMs
        };
        this.scenarioHoverCache.set(key, refreshed);
        return refreshed;
    }

    private async getHoverTranslator(): Promise<(message: string, ...args: string[]) => string> {
        const languageOverride = vscode.workspace
            .getConfiguration('kotTestToolkit.localization')
            .get<string>('languageOverride') || 'System';

        if (!this.hoverTranslator || this.hoverTranslatorLanguageOverride !== languageOverride) {
            this.hoverTranslator = await getTranslator(this.context.extensionUri);
            this.hoverTranslatorLanguageOverride = languageOverride;
        }

        return this.hoverTranslator;
    }

    private async provideScenarioCallHover(lineText: string): Promise<vscode.Hover | null> {
        if (!this.scenarioCacheProvider) {
            return null;
        }

        const calledScenarioName = this.parseScenarioCallNameFromLine(lineText);
        if (!calledScenarioName) {
            return null;
        }

        const testCache = this.scenarioCacheProvider.getTestCache();
        const calledScenarioInfo = testCache?.get(calledScenarioName);
        if (!calledScenarioInfo) {
            return null;
        }

        const hoverData = await this.getScenarioHoverCachedData(calledScenarioInfo);
        const parametersCount = calledScenarioInfo.parameters?.length ?? 0;
        const nestedScenariosCount = calledScenarioInfo.nestedScenarioNames?.length ?? 0;
        const filesValue = String(hoverData.filesCount);
        const paramsValue = String(parametersCount);
        const nestedValue = String(nestedScenariosCount);
        const t = await this.getHoverTranslator();
        const nestedScenarioLabel = t('Nested scenario');
        const attachedFilesLabel = t('Attached files');
        const parametersLabel = t('Parameters');
        const nestedScenariosLabel = t('Nested scenarios');
        const descriptionLabel = t('Description');
        const emptyLabel = t('Empty.');
        const missingKotMetadataLabel = t('KOT metadata block is missing.');

        const content = new vscode.MarkdownString();
        content.appendMarkdown(`**${nestedScenarioLabel}:** \`${calledScenarioName}\`\n\n`);
        content.appendMarkdown(
            `**${attachedFilesLabel}:** \`${filesValue}\`  •  ` +
            `**${parametersLabel}:** \`${paramsValue}\`  •  ` +
            `**${nestedScenariosLabel}:** \`${nestedValue}\`\n\n`
        );

        if (!hoverData.descriptionInfo.hasKotMetadata) {
            content.appendMarkdown(`**${descriptionLabel}:** _${missingKotMetadataLabel}_\n\n`);
        } else if (!hoverData.descriptionInfo.description) {
            content.appendMarkdown(`**${descriptionLabel}:** _${emptyLabel}_\n\n`);
        } else {
            content.appendMarkdown(`**${descriptionLabel}:**\n\n`);
            this.appendCompactMultilineText(content, hoverData.descriptionInfo.description);
            content.appendMarkdown('\n\n');
        }

        return new vscode.Hover(content);
    }

    public async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | null> {
        // Проверяем, что это файл сценария YAML
        const { isScenarioYamlFile } = await import('./yamlValidator.js');
        if (!isScenarioYamlFile(document)) {
            return null;
        }

        // Показываем подсказки только в блоках текста сценария
        if (!this.isInScenarioTextBlock(document, position)) {
            return null;
        }
        
        // Получаем текст строки
        const lineText = document.lineAt(position.line).text.trim();
        if (!lineText || lineText.startsWith('#') || lineText.startsWith('|') || lineText.startsWith('"""')) {
            return null;
        }

        const scenarioCallHover = await this.provideScenarioCallHover(lineText);
        if (scenarioCallHover) {
            return scenarioCallHover;
        }

        if (this.isLoading && this.loadingPromise) {
            await this.loadingPromise;
        } else if (this.stepDefinitions.length === 0 && !this.isLoading) {
            await this.loadStepDefinitions();
        }

        if (token.isCancellationRequested || this.stepDefinitions.length === 0) {
            return null;
        }
        
        for (const stepDef of this.stepDefinitions) {
            if (token.isCancellationRequested) return null;
            try {
                if (this.matchLineToPattern(lineText, stepDef)) {
                    const content = new vscode.MarkdownString();
                    const isRussianInput = this.isRussianText(lineText);
                    const descriptionText = isRussianInput && stepDef.russianDescription
                        ? stepDef.russianDescription
                        : stepDef.description || stepDef.russianDescription || '';
                    const descriptionHeader = isRussianInput && stepDef.russianDescription
                        ? 'Описание'
                        : 'Description';

                    const lineLiterals = this.extractStepArgumentLiterals(lineText);
                    const primaryExample = this.applyLineLiteralsToTemplate(stepDef.pattern, lineLiterals);
                    const secondaryTemplate = stepDef.russianPattern;
                    const secondaryExample = secondaryTemplate
                        ? this.applyLineLiteralsToTemplate(secondaryTemplate, lineLiterals)
                        : null;

                    content.appendMarkdown(`**${descriptionHeader}:**\n\n`);
                    this.appendCompactMultilineText(content, descriptionText);
                    content.appendMarkdown('\n\n');
                    content.appendMarkdown(`---\n\n\`${primaryExample}\``);
                    if (secondaryExample && secondaryExample !== primaryExample) {
                        content.appendMarkdown(`\n\n\`${secondaryExample}\``);
                    }

                    return new vscode.Hover(content);
                }
            } catch (error) {
                console.error(`[DriveHoverProvider] Ошибка сопоставления строки "${lineText}" с "${stepDef.firstLine}": ${error}`);
            }
        }
        
        return null;
    }

    private appendCompactMultilineText(markdown: vscode.MarkdownString, text: string): void {
        const normalized = text.replace(/\r\n|\r/g, '\n').trim();
        if (!normalized) {
            return;
        }

        const collapsedLines: string[] = [];
        let previousWasBlank = false;
        for (const rawLine of normalized.split('\n')) {
            const line = rawLine.replace(/\s+$/g, '');
            const isBlank = line.trim().length === 0;
            if (isBlank) {
                if (!previousWasBlank) {
                    collapsedLines.push('');
                }
                previousWasBlank = true;
                continue;
            }

            collapsedLines.push(line);
            previousWasBlank = false;
        }

        while (collapsedLines.length > 0 && collapsedLines[0] === '') {
            collapsedLines.shift();
        }
        while (collapsedLines.length > 0 && collapsedLines[collapsedLines.length - 1] === '') {
            collapsedLines.pop();
        }

        collapsedLines.forEach((line, index) => {
            if (line === '') {
                markdown.appendMarkdown('\n');
                return;
            }

            markdown.appendText(line);
            if (index < collapsedLines.length - 1) {
                markdown.appendMarkdown('  \n');
            }
        });
    }

    private isInScenarioTextBlock(document: vscode.TextDocument, position: vscode.Position): boolean {
        if (!document.fileName.toLowerCase().endsWith('.yaml')) return false;
        const textUpToPosition = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
        const scenarioBlockStartRegex = /\nТекстСценария:\s*\|?\s*(\r\n|\r|\n)/m;
        let lastScenarioBlockStart = -1;
        let match;
        const globalRegex = new RegExp(scenarioBlockStartRegex.source, 'gm');
        while((match = globalRegex.exec(textUpToPosition)) !== null) {
            lastScenarioBlockStart = match.index + match[0].length;
        }
        return lastScenarioBlockStart !== -1;
    }

    private isRussianText(text: string): boolean {
        // Простая эвристика для определения русского текста
        // Ищем кириллические символы
        const russianRegex = /[а-яё]/i;
        return russianRegex.test(text);
    }

    private normalizeForSuggestion(text: string): string {
        const gherkinKeywords = /^(?:And|But|Then|When|Given|If|Но|Тогда|Когда|Если|И|К тому же|Допустим)\s+/i;
        return text
            .trim()
            .replace(gherkinKeywords, '')
            .replace(/"%\d+\s+[^"]*"/g, ' ')
            .replace(/"[^"]*"/g, ' ')
            .replace(/'[^']*'/g, ' ')
            .replace(/\[[^\]]+\]/g, ' ')
            .replace(/[.,;:!?()]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    private calculateSimilarity(a: string, b: string): number {
        if (!a || !b) {
            return 0;
        }
        if (a === b) {
            return 1;
        }
        const distance = this.levenshteinDistance(a, b);
        const maxLen = Math.max(a.length, b.length);
        return maxLen === 0 ? 0 : (1 - distance / maxLen);
    }

    private levenshteinDistance(a: string, b: string): number {
        const rows = a.length + 1;
        const cols = b.length + 1;
        const matrix: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

        for (let i = 0; i < rows; i++) {
            matrix[i][0] = i;
        }
        for (let j = 0; j < cols; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i < rows; i++) {
            for (let j = 1; j < cols; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j - 1] + cost
                );
            }
        }

        return matrix[a.length][b.length];
    }
}
