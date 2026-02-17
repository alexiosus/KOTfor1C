import * as vscode from 'vscode';
import { parse } from 'node-html-parser';
import { getStepsHtml, forceRefreshSteps as forceRefreshStepsCore } from './stepsFetcher';
import { TestInfo } from './types';
import { getTranslator } from './localization';
import { parseScenarioParameterDefaults } from './scenarioParameterUtils';
import { getScenarioCallKeyword, getScenarioLanguageForDocument } from './gherkinLanguage';

const VARIABLE_REFERENCE_PREFIX_REGEX = /^[A-Za-zА-Яа-яЁё0-9_]*$/;
const SAVE_VARIABLE_STEP_REGEX_EN = /^\s*(?:(?:And|Then|When|Given|But|И|Тогда|Когда|Если|Допустим|К тому же|Но)\s+)?I\s+save\s+(.+?)\s+in\s+(?:"([^"]+)"|'([^']+)')\s+variable\s*$/i;
const SAVE_VARIABLE_STEP_REGEX_RU = /^\s*(?:(?:And|Then|When|Given|But|И|Тогда|Когда|Если|Допустим|К тому же|Но)\s+)?Я\s+запоминаю\s+значение\s+выражения\s+(.+?)\s+в\s+переменную\s+(?:"([^"]+)"|'([^']+)')\s*$/i;

interface SavedVariableDefinition {
    name: string;
    value: string;
}

export class DriveCompletionProvider implements vscode.CompletionItemProvider {
    private gherkinCompletionItems: vscode.CompletionItem[] = [];
    private scenarioCompletionItems: vscode.CompletionItem[] = [];
    private scenarioParametersByName: Map<string, string[]> = new Map();
    private calledScenarioDefaultsByName: Map<string, Map<string, string>> = new Map();
    private scenarioDefaultsByDocument = new Map<string, { version: number; defaults: Map<string, string> }>();
    private isLoadingGherkin: boolean = false;
    private loadingGherkinPromise: Promise<void> | null = null;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.context.subscriptions.push(
            vscode.workspace.onDidCloseTextDocument(document => {
                this.scenarioDefaultsByDocument.delete(document.uri.toString());
            })
        );
        this.loadGherkinCompletionItems().catch(async err => {
            const t = await getTranslator(context.extensionUri);
            vscode.window.showErrorMessage(t('Error initializing Gherkin autocompletion: {0}', err.message));
        });
        console.log("[DriveCompletionProvider] Initialized. Scenario completions will be updated externally.");
    }

    // Метод для принудительного обновления шагов Gherkin
    public async refreshSteps(): Promise<void> {
        console.log("[DriveCompletionProvider] Refreshing Gherkin steps triggered...");
        this.gherkinCompletionItems = [];
        this.loadingGherkinPromise = null;
        this.isLoadingGherkin = false;
        try {
            // Вызываем основную логику обновления из stepsFetcher
            const htmlContent = await forceRefreshStepsCore(this.context);
            this.parseAndStoreGherkinCompletions(htmlContent);
            console.log("[DriveCompletionProvider] Gherkin steps refreshed and re-parsed successfully.");
        } catch (error: any) {
            console.error(`[DriveCompletionProvider] Failed to refresh Gherkin steps: ${error.message}`);
            // Если принудительное обновление не удалось, пытаемся загрузить хоть что-то
            // чтобы расширение не осталось без автодополнения
            await this.loadGherkinCompletionItems();
        }
    }

    // Метод для обновления списка автодополнений сценариев
    public updateScenarioCompletions(scenarios: Map<string, TestInfo> | null): void {
        this.scenarioCompletionItems = []; // Очищаем перед заполнением
        this.scenarioParametersByName.clear();
        this.calledScenarioDefaultsByName.clear();
        if (!scenarios || scenarios.size === 0) {
            console.log("[DriveCompletionProvider] No scenarios provided for completion items.");
            return;
        }

        scenarios.forEach((scenarioInfo, scenarioName) => {
            // Метка, которую увидит пользователь в списке автодополнения
            const item = new vscode.CompletionItem(scenarioName, vscode.CompletionItemKind.Function);
            const scenarioDescription = (scenarioInfo.scenarioDescription || '').trim();

            item.detail = vscode.l10n.t('Nested scenario (1C)');
            if (scenarioDescription) {
                const firstLine = scenarioDescription.split(/\r\n|\r|\n/)[0].trim();
                if (firstLine) {
                    item.detail = `${item.detail} - ${firstLine}`;
                }
            }
            const itemDocumentation = new vscode.MarkdownString();
            itemDocumentation.appendMarkdown(vscode.l10n.t('Call scenario "{0}".', scenarioName));
            if (scenarioDescription) {
                itemDocumentation.appendMarkdown(`\n\n**${vscode.l10n.t('Description')}:**\n\n`);
                this.appendCompactMultilineText(itemDocumentation, scenarioDescription);
            }
            item.documentation = itemDocumentation;
            // Текст, по которому будет происходить фильтрация при вводе пользователя
            // (без "And ", чтобы можно было просто начать печатать имя сценария)
            item.filterText = scenarioName;

            item.insertText = scenarioName;

            const scenarioParameters = (scenarioInfo.parameters || [])
                .map(param => param.trim())
                .filter(Boolean);
            if (scenarioParameters.length > 0) {
                this.scenarioParametersByName.set(scenarioName, scenarioParameters);
            }

            if (scenarioInfo.parameterDefaults) {
                const defaultsMap = new Map<string, string>();
                Object.entries(scenarioInfo.parameterDefaults).forEach(([paramName, defaultValue]) => {
                    const normalizedParamName = paramName.trim();
                    if (normalizedParamName && typeof defaultValue === 'string') {
                        defaultsMap.set(normalizedParamName, defaultValue);
                    }
                });
                if (defaultsMap.size > 0) {
                    this.calledScenarioDefaultsByName.set(scenarioName, defaultsMap);
                }
            }
            // Приоритет ниже, чем у шагов Gherkin (начинающихся с "0"), сортировка по имени сценария
            // sortText будет формироваться в provideCompletionItems на основе оценки совпадения
            // item.sortText = "1" + scenarioName;

            this.scenarioCompletionItems.push(item);
        });
        console.log(`[DriveCompletionProvider] Updated with ${this.scenarioCompletionItems.length} scenario completions.`);
    }


    private parseAndStoreGherkinCompletions(htmlContent: string): void {
        this.gherkinCompletionItems = []; // Очищаем перед заполнением
        if (!htmlContent) {
            console.warn("[DriveCompletionProvider] HTML content is null or empty for Gherkin steps.");
            return;
        }
        const root = parse(htmlContent);
        const rows = root.querySelectorAll('tr');

        rows.forEach(row => {
            const rowClass = row.classNames;
            // Проверяем, что класс строки начинается с 'R' (предполагая, что это строки с шагами)
            if (!rowClass || !rowClass.startsWith('R')) {
                return; // Пропускаем строки заголовков или другие нерелевантные
            }

            const cells = row.querySelectorAll('td');
            // Убедимся, что есть хотя бы 4 ячейки для русского шага
            if (cells.length >= 4) {
                // Структура: колонки 1-2 русские, колонки 3-4 английские
                const russianStepText = cells[0].textContent.trim();
                const russianStepDescription = cells[1].textContent.trim();

                // Получаем английские варианты, если они есть (колонки 3-4)
                const stepText = cells.length >= 4 ? this.normalizeLineBreaks(cells[2].textContent.trim()) : '';
                const stepDescription = cells.length >= 4 ? this.normalizeLineBreaks(cells[3].textContent.trim()) : '';

                // Создаем элемент автодополнения для русского шага (если он есть)
                if (russianStepText) {
                    const russianItem = new vscode.CompletionItem(russianStepText, vscode.CompletionItemKind.Snippet);

                    // Создаем документацию: русское описание + оба варианта шагов
                    const russianDoc = new vscode.MarkdownString();
                    russianDoc.appendMarkdown(`**Описание:**\n\n${russianStepDescription}\n\n`);
                    russianDoc.appendMarkdown(`\`${russianStepText}\``);
                    if (stepText) {
                        russianDoc.appendMarkdown(`\n\n\`${stepText}\``);
                    }

                    russianItem.documentation = russianDoc;
                    russianItem.detail = "Gherkin Step (1C) - Russian";
                    russianItem.insertText = russianStepText;
                    this.gherkinCompletionItems.push(russianItem);
                }

                // Создаем элемент автодополнения для английского шага (если он есть)
                if (stepText) {
                    const item = new vscode.CompletionItem(stepText, vscode.CompletionItemKind.Snippet);

                    // Создаем документацию: английское описание + оба варианта шагов
                    const englishDoc = new vscode.MarkdownString();
                    englishDoc.appendMarkdown(`**Description:**\n\n${stepDescription}\n\n`);
                    englishDoc.appendMarkdown(`\`${stepText}\``);
                    if (russianStepText) {
                        englishDoc.appendMarkdown(`\n\n\`${russianStepText}\``);
                    }

                    item.documentation = englishDoc;
                    item.detail = "Gherkin Step (1C) - English";
                    item.insertText = stepText;
                    this.gherkinCompletionItems.push(item);
                }
            }
        });
        console.log(`[DriveCompletionProvider] Parsed and stored ${this.gherkinCompletionItems.length} Gherkin completion items.`);
    }

    private loadGherkinCompletionItems(): Promise<void> {
        // Если загрузка уже идет, возвращаем существующий промис
        if (this.isLoadingGherkin && this.loadingGherkinPromise) {
            return this.loadingGherkinPromise;
        }
        // Если элементы уже загружены и нет активной загрузки, просто возвращаем
        if (this.gherkinCompletionItems.length > 0 && !this.isLoadingGherkin) {
            return Promise.resolve();
        }

        this.isLoadingGherkin = true;
        console.log("[DriveCompletionProvider] Starting to load Gherkin completion items...");

        // Используем getStepsHtml из stepsFetcher
        this.loadingGherkinPromise = getStepsHtml(this.context)
            .then(htmlContent => {
                this.parseAndStoreGherkinCompletions(htmlContent);
            })
            .catch(async error => {
                console.error(`[DriveCompletionProvider] Ошибка загрузки или парсинга steps.htm: ${error.message}`);
                const t = await getTranslator(this.context.extensionUri);
                vscode.window.showErrorMessage(t('Failed to load Gherkin steps for autocompletion: {0}', error.message));
                this.gherkinCompletionItems = []; // Убедимся, что список пуст в случае ошибки
            })
            .finally(() => {
                this.isLoadingGherkin = false;
                // Не обнуляем loadingPromise здесь, чтобы повторные быстрые вызовы во время первой загрузки
                // все еще могли использовать его. Он будет сброшен принудительно при refreshSteps
                // или если gherkinCompletionItems пуст при следующем вызове loadGherkinCompletionItems.
                console.log("[DriveCompletionProvider] Finished Gherkin loading attempt.");
            });

        return this.loadingGherkinPromise;
    }

    /**
     * Основной метод, предоставляющий автодополнение
     */
    public async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList> {

        console.log("[DriveCompletionProvider:provideCompletionItems] Triggered.");

        // Проверяем, что это файл сценария YAML
        const { isScenarioYamlFile } = await import('./yamlValidator.js');
        if (!isScenarioYamlFile(document)) {
            console.log("[DriveCompletionProvider:provideCompletionItems] Not a scenario YAML file. Returning empty.");
            return [];
        }

        // Предоставляем автодополнение только в блоках текста сценария
        if (!this.isInScenarioTextBlock(document, position)) {
            console.log("[DriveCompletionProvider:provideCompletionItems] Not in scenario text block. Returning empty.");
            return [];
        }

        // Получаем текст текущей строки до позиции курсора
        const lineText = document.lineAt(position.line).text;
        const linePrefix = lineText.substring(0, position.character); // Текст строки до курсора

        const variableReferenceContext = this.getVariableReferenceContext(linePrefix);
        if (variableReferenceContext) {
            return this.buildSavedVariableCompletionList(document, position, variableReferenceContext);
        }

        // Если элементы Gherkin еще не загружены или идет загрузка, дождемся ее завершения
        if (this.isLoadingGherkin && this.loadingGherkinPromise) {
            console.log("[DriveCompletionProvider:provideCompletionItems] Waiting for Gherkin load to complete...");
            await this.loadingGherkinPromise;
        } else if (this.gherkinCompletionItems.length === 0 && !this.isLoadingGherkin) {
            // Если загрузка Gherkin не идет, но элементов нет, попробуем загрузить
            console.log("[DriveCompletionProvider:provideCompletionItems] Gherkin items not loaded, attempting to load now...");
            await this.loadGherkinCompletionItems();
        }

        // Создаем список автодополнения
        const completionList = new vscode.CompletionList();

        // Ищем отступы и ключевые слова в начале строки (регистронезависимо)
        const lineStartPattern = /^(\s*)(and|then|when|given|и|тогда|когда|если|допустим|к тому же|но)?\s*/i;
        const lineStartMatch = linePrefix.match(lineStartPattern);

        if (!lineStartMatch) {
            // Этого не должно произойти, если isInScenarioTextBlock вернуло true и строка не пустая,
            // но на всякий случай.
            console.log("[DriveCompletionProvider:provideCompletionItems] Line prefix does not match Gherkin start pattern. Returning empty.");
            return completionList;
        }

        const indentation = lineStartMatch[1] || ''; // Отступы в начале строки
        const keywordInLine = (lineStartMatch[2] || '').toLowerCase(); // Найденное ключевое слово Gherkin (или пусто, если его нет)
        const gherkinPrefixInLine = lineStartMatch[0]; // Полный префикс с отступом и ключевым словом, например "    And "

        // Текст, который пользователь ввел ПОСЛЕ отступов (и возможно, ключевого слова Gherkin)
        const userTextAfterIndentation = linePrefix.substring(indentation.length);
        // Текст, который пользователь ввел ПОСЛЕ ключевого слова (если оно было)
        const userTextAfterKeyword = linePrefix.substring(gherkinPrefixInLine.length);

        console.log(`[DriveCompletionProvider:provideCompletionItems] Indent: '${indentation}', KeywordInLine: '${keywordInLine}', UserTextAfterKeyword: '${userTextAfterKeyword}', UserTextAfterIndentation: '${userTextAfterIndentation}'`);

        // Добавляем Gherkin шаги
        const scenarioLanguage = getScenarioLanguageForDocument(document);
        const scenarioCallKeyword = getScenarioCallKeyword(scenarioLanguage);
        this.gherkinCompletionItems.forEach(baseItem => {
            const itemFullText = typeof baseItem.label === 'string' ? baseItem.label : baseItem.label.label; // Полный текст элемента автодополнения

            // Извлекаем ключевое слово из самого шага Gherkin, если оно там есть
            const itemStartPatternGherkin = /^(And|Then|When|Given|Но|Тогда|Когда|Если|И|К тому же|Допустим)\s+/i;
            const itemKeywordMatch = itemFullText.match(itemStartPatternGherkin);
            const itemKeywordFromStep = itemKeywordMatch ? itemKeywordMatch[0].trim().toLowerCase() : ''; // Ключевое слово из элемента
            const itemTextAfterKeywordInItem = itemKeywordMatch ? itemFullText.substring(itemKeywordMatch[0].length) : itemFullText; // Текст элемента после ключевого слова

            // Фильтруем по совпадению ключевого слова, если оно есть в строке пользователя
            // Если в строке пользователя нет ключевого слова, то itemKeywordFromStep должен быть пустым (или мы должны предлагать все типы шагов)
            // Для простоты: если пользователь ввел ключевое слово, оно должно совпадать с ключевым словом шага.
            // Если пользователь не ввел ключевое слово, предлагаем все шаги, но matching будет по тексту после ключевого слова шага.
            if (keywordInLine && itemKeywordFromStep && keywordInLine !== itemKeywordFromStep) {
                return;
            }

            // Текст для нечеткого сопоставления:
            // Если пользователь ввел ключевое слово, сопоставляем то, что после него.
            // Если не ввел, сопоставляем весь введенный текст после отступа с текстом шага после его ключевого слова.
            const textToMatchAgainst = keywordInLine ? userTextAfterKeyword : userTextAfterIndentation;
            const itemTextForMatching = itemTextAfterKeywordInItem;

            const matchResult = this.fuzzyMatch(itemTextForMatching, textToMatchAgainst);
            if (matchResult.matched) {
                const completionItem = new vscode.CompletionItem(itemFullText, baseItem.kind);
                completionItem.documentation = baseItem.documentation;
                completionItem.detail = baseItem.detail;

                // Заменяем всю строку, начиная с отступа
                const replacementRange = new vscode.Range(
                    position.line,
                    indentation.length, // Начало текста после отступа
                    position.line,
                    position.character // Заменяем только то, что пользователь ввел после отступа
                );
                completionItem.range = replacementRange;
                const baseInsertText = typeof baseItem.insertText === 'string'
                    ? baseItem.insertText
                    : itemFullText;
                completionItem.insertText = baseInsertText;
                // Сортировка по релевантности
                completionItem.sortText = "0" + (1 - matchResult.score).toFixed(3) + itemFullText; // Используем toFixed(3) для большей гранулярности
                completionList.items.push(completionItem);
            }
        });

        // Добавляем вызовы сценариев
        // Текст, который пользователь ввел после отступа, очищенный от возможного "And " в начале
        const textForScenarioFuzzyMatch = userTextAfterIndentation.replace(/^(And|И|Допустим)\s+/i, '');
        const scenarioParameterDefaults = this.getScenarioParameterDefaults(document);
        console.log(`[DriveCompletionProvider:provideCompletionItems] Text for scenario fuzzy match: '${textForScenarioFuzzyMatch}' (based on userTextAfterIndentation: '${userTextAfterIndentation}')`);

        this.scenarioCompletionItems.forEach(baseScenarioItem => {
            const scenarioName = baseScenarioItem.filterText || (typeof baseScenarioItem.label === 'string'
                ? baseScenarioItem.label
                : baseScenarioItem.label.label);
            if (!scenarioName) {
                return;
            }

            // baseScenarioItem.filterText это "ИмяСценария"
            const matchResult = this.fuzzyMatch(scenarioName, textForScenarioFuzzyMatch);

            if (matchResult.matched) {
                const completionItem = new vscode.CompletionItem(`${scenarioCallKeyword} ${scenarioName}`, baseScenarioItem.kind);
                completionItem.filterText = scenarioName; // filterText = "ИмяСценария"
                completionItem.documentation = baseScenarioItem.documentation;
                completionItem.detail = baseScenarioItem.detail;
                const {
                    baseIndent: scenarioCallBaseIndent,
                    firstLinePrefix: scenarioCallFirstLinePrefix,
                    replacementStartCharacter: scenarioCallReplacementStart
                } = this.resolveScenarioCallInsertIndent(document, position);

                // Диапазон для замены: от начала пользовательского ввода (после отступа) до текущей позиции курсора.
                const replacementRange = new vscode.Range(
                    position.line,
                    scenarioCallReplacementStart,
                    position.line,
                    position.character
                );
                completionItem.range = replacementRange;

                completionItem.insertText = this.buildScenarioCallInsertText(
                    scenarioName,
                    scenarioCallBaseIndent,
                    scenarioCallFirstLinePrefix,
                    scenarioParameterDefaults,
                    scenarioCallKeyword
                );

                completionItem.sortText = "1" + (1 - matchResult.score).toFixed(3) + scenarioName; // Используем toFixed(3)
                console.log(`[Scenario Autocomplete] Label: "${completionItem.label}", Scenario Name: ${scenarioName}, Input: "${textForScenarioFuzzyMatch}", Score: ${matchResult.score.toFixed(3)}, SortText: ${completionItem.sortText}`);
                completionList.items.push(completionItem);
            }
        });

        console.log(`[DriveCompletionProvider:provideCompletionItems] Total Gherkin items: ${this.gherkinCompletionItems.length}, Total Scenario items: ${this.scenarioCompletionItems.length}, Proposed items: ${completionList.items.length}`);
        return completionList;
    }

    private resolveScenarioCallInsertIndent(
        document: vscode.TextDocument,
        position: vscode.Position
    ): { baseIndent: string; firstLinePrefix: string; replacementStartCharacter: number } {
        const defaultIndent = '    ';
        const currentLineText = document.lineAt(position.line).text;
        const cursorCharacter = Math.max(0, Math.min(position.character, currentLineText.length));
        const beforeCursorText = currentLineText.slice(0, cursorCharacter);
        const currentLineLeadingIndent = currentLineText.match(/^\s*/)?.[0] ?? '';
        const lineHasContent = currentLineText.trim().length > 0;

        if (lineHasContent) {
            return {
                baseIndent: currentLineLeadingIndent,
                firstLinePrefix: '',
                replacementStartCharacter: currentLineLeadingIndent.length
            };
        }

        if (/^\s+$/.test(beforeCursorText)) {
            return {
                baseIndent: beforeCursorText,
                firstLinePrefix: '',
                replacementStartCharacter: beforeCursorText.length
            };
        }

        for (let line = position.line - 1; line >= 0; line--) {
            const text = document.lineAt(line).text;
            if (text.trim().length === 0) {
                continue;
            }

            const indent = text.match(/^\s*/)?.[0] ?? '';
            return {
                baseIndent: indent,
                firstLinePrefix: indent,
                replacementStartCharacter: 0
            };
        }

        return {
            baseIndent: defaultIndent,
            firstLinePrefix: defaultIndent,
            replacementStartCharacter: 0
        };
    }

    private getVariableReferenceContext(
        linePrefix: string
    ): { startCharacter: number; typedPrefix: string } | null {
        const lastDollarIndex = linePrefix.lastIndexOf('$');
        if (lastDollarIndex < 0) {
            return null;
        }

        const typedPrefix = linePrefix.substring(lastDollarIndex + 1);
        if (typedPrefix.includes('$') || /\s/.test(typedPrefix)) {
            return null;
        }

        if (!VARIABLE_REFERENCE_PREFIX_REGEX.test(typedPrefix)) {
            return null;
        }

        return {
            startCharacter: lastDollarIndex,
            typedPrefix
        };
    }

    private buildSavedVariableCompletionList(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: { startCharacter: number; typedPrefix: string }
    ): vscode.CompletionList {
        const completionList = new vscode.CompletionList([], false);
        const savedVariables = this.collectSavedVariableDefinitionsBeforeLine(document, position.line);
        if (savedVariables.length === 0) {
            return completionList;
        }

        const typedPrefixLower = context.typedPrefix.toLocaleLowerCase();
        const filteredVariables = savedVariables.filter(variable => {
            if (!typedPrefixLower) {
                return true;
            }

            const normalizedName = variable.name.toLocaleLowerCase();
            return normalizedName.startsWith(typedPrefixLower) || normalizedName.includes(typedPrefixLower);
        });

        if (filteredVariables.length === 0) {
            return completionList;
        }

        filteredVariables.forEach((variable, index) => {
            const variableName = variable.name;
            const variableReference = `$${variableName}$`;
            const completionItem = new vscode.CompletionItem(variableName, vscode.CompletionItemKind.Variable);
            completionItem.detail = vscode.l10n.t(
                'Saved variable: {0}',
                this.buildSavedVariableValuePreview(variable.value)
            );
            completionItem.insertText = variableReference;
            completionItem.filterText = variableReference;
            completionItem.label = {
                label: variableName,
                detail: `  ${variableReference}`
            };
            completionItem.sortText = `${index.toString().padStart(3, '0')}_${variableName.toLocaleLowerCase()}`;
            completionItem.range = new vscode.Range(
                position.line,
                context.startCharacter,
                position.line,
                position.character
            );
            completionList.items.push(completionItem);
        });

        return completionList;
    }

    private collectSavedVariableDefinitionsBeforeLine(document: vscode.TextDocument, lineExclusive: number): SavedVariableDefinition[] {
        const variables: SavedVariableDefinition[] = [];
        const seen = new Set<string>();

        for (let line = lineExclusive - 1; line >= 0; line--) {
            const lineText = document.lineAt(line).text;
            const variable = this.extractSavedVariableFromStepLine(lineText);
            if (!variable) {
                continue;
            }

            const normalized = variable.name.toLocaleLowerCase();
            if (seen.has(normalized)) {
                continue;
            }
            seen.add(normalized);
            variables.push(variable);
        }

        return variables;
    }

    private extractSavedVariableFromStepLine(lineText: string): SavedVariableDefinition | null {
        const englishMatch = lineText.match(SAVE_VARIABLE_STEP_REGEX_EN);
        const russianMatch = lineText.match(SAVE_VARIABLE_STEP_REGEX_RU);
        const rawName = englishMatch?.[2] || englishMatch?.[3] || russianMatch?.[2] || russianMatch?.[3];
        const variableName = (rawName || '').trim();
        if (!variableName) {
            return null;
        }

        const rawValue = englishMatch?.[1] || russianMatch?.[1] || '';
        return {
            name: variableName,
            value: rawValue.trim()
        };
    }

    private buildSavedVariableValuePreview(value: string): string {
        if (!value) {
            return '…';
        }
        const singleLine = value.replace(/\s+/g, ' ').trim();
        const maxLength = 60;
        if (singleLine.length <= maxLength) {
            return singleLine;
        }
        return `${singleLine.slice(0, maxLength - 1)}…`;
    }

    /**
     * Выполняет нечеткое сопоставление шаблона и введенного текста
     * @param pattern Шаблон для сравнения
     * @param input Введенный пользователем текст
     * @returns Объект с флагом соответствия и оценкой совпадения (0-1)
     */
    private fuzzyMatch(pattern: string, input: string): { matched: boolean, score: number } {
        const patternLower = pattern.toLowerCase();
        const inputLower = input.toLowerCase();

        if (!inputLower) {
            return { matched: true, score: 0.1 };
        }

        // 1. Точное совпадение начала строки
        if (patternLower.startsWith(inputLower)) {
            // Чем длиннее совпадение относительно общей длины шаблона, тем выше оценка
            return { matched: true, score: 0.8 + (inputLower.length / patternLower.length) * 0.2 }; // Score 0.8 to 1.0
        }

        // 2. Ввод является подстрокой шаблона (не обязательно с начала)
        if (patternLower.includes(inputLower)) {
            const startIndex = patternLower.indexOf(inputLower);
            // Оценка выше, если подстрока длиннее и ближе к началу
            return { matched: true, score: 0.6 + (inputLower.length / patternLower.length) * 0.1 - (startIndex / patternLower.length) * 0.1 }; // Score ~0.5 to ~0.7
        }

        // 3. Сопоставление по словам
        const patternWords = patternLower.split(/\s+/).filter(w => w.length > 0);
        const inputWords = inputLower.split(/\s+/).filter(w => w.length > 0);

        if (inputWords.length === 0) { // Если ввод есть, но не разделяется на слова (например, одно слово без пробелов)
             for (const pWord of patternWords) {
                 if (pWord.startsWith(inputLower)) return {matched: true, score: 0.55}; // Если одно из слов шаблона начинается с введенного текста
             }
             return { matched: false, score: 0 }; // Если одиночное слово ввода не найдено как начало ни одного слова шаблона
        }

        let matchedWordCount = 0;
        let firstMatchInPatternIndex = -1;
        let lastMatchInPatternIndex = -1;
        let orderMaintained = true;
        let currentPatternWordIndex = -1;

        for (let i = 0; i < inputWords.length; i++) {
            const inputWord = inputWords[i];
            let foundThisWord = false;
            for (let j = currentPatternWordIndex + 1; j < patternWords.length; j++) {
                const patternWord = patternWords[j];
                if (patternWord.startsWith(inputWord)) {
                    matchedWordCount++;
                    if (firstMatchInPatternIndex === -1) firstMatchInPatternIndex = j;
                    lastMatchInPatternIndex = j;
                    currentPatternWordIndex = j; // Для проверки порядка
                    foundThisWord = true;
                    break;
                }
            }
            if (!foundThisWord && i > 0) { // Если не первое слово ввода не найдено, порядок нарушен
                orderMaintained = false;
            }
        }

        if (matchedWordCount > 0) {
            const matchRatio = matchedWordCount / inputWords.length; // Насколько полно совпали слова ввода
            let score = 0.3 + (matchRatio * 0.2); // Базовая оценка за совпадение слов (0.3 до 0.5)

            if (orderMaintained && matchedWordCount === inputWords.length) {
                score += 0.1; // Бонус за полный порядок
                if (firstMatchInPatternIndex === 0) {
                    score += 0.05; // Небольшой бонус, если совпадение началось с первого слова шаблона
                }
            }
            // Учитываем "плотность" совпавших слов в шаблоне
            if (lastMatchInPatternIndex !== -1 && firstMatchInPatternIndex !== -1 && matchedWordCount > 1) {
                const spread = lastMatchInPatternIndex - firstMatchInPatternIndex + 1;
                score += (matchedWordCount / spread) * 0.05; // Бонус за "кучность"
            }

            return { matched: true, score: Math.min(score, 0.65) }; // Ограничиваем максимальную оценку для этого типа совпадения
        }

        return { matched: false, score: 0 };
    }

    /**
     * Проверяет, находится ли позиция в блоке текста сценария
     */
    private isInScenarioTextBlock(document: vscode.TextDocument, position: vscode.Position): boolean {
        // Простая проверка: работаем только с YAML файлами
        if (document.fileName.toLowerCase().endsWith('.yaml')) {
            // Ищем "ТекстСценария:" до текущей позиции курсора
            const textUpToPosition = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
            const scenarioBlockStartRegex = /ТекстСценария:\s*\|?\s*(\r\n|\r|\n)/m; // 'm' для многострочного поиска
            let lastScenarioBlockStartOffset = -1;
            let match;

            // Находим последнее вхождение "ТекстСценария:" перед курсором
            const globalRegex = new RegExp(scenarioBlockStartRegex.source, 'gm');
            while((match = globalRegex.exec(textUpToPosition)) !== null) {
                lastScenarioBlockStartOffset = match.index + match[0].length; // Запоминаем позицию ПОСЛЕ найденного блока
            }

            if (lastScenarioBlockStartOffset === -1) {
                // console.log("[isInScenarioTextBlock] 'ТекстСценария:' not found before cursor.");
                return false; // Блок "ТекстСценария:" не найден перед курсором
            }

            // Теперь проверяем, не вышли ли мы из этого блока в другую секцию YAML
            // Берем текст от начала последнего найденного блока "ТекстСценария:" до текущей позиции курсора
            const textAfterLastBlockStart = textUpToPosition.substring(lastScenarioBlockStartOffset);

            // Ищем строки, которые начинаются без отступа (или с меньшим отступом, чем ожидается для шагов)
            // и содержат двоеточие, что указывает на новую секцию YAML.
            // Шаги Gherkin обычно имеют отступ (например, 4 пробела или 1 таб).
            // Секции YAML верхнего уровня (ДанныеСценария, ПараметрыСценария, ВложенныеСценарии) обычно начинаются без отступа или с меньшим.
            const linesInBlock = textAfterLastBlockStart.split(/\r\n|\r|\n/);
            for (const line of linesInBlock) {
                const trimmedLine = line.trim();
                if (trimmedLine === "") continue; // Пропускаем пустые строки
                if (trimmedLine.startsWith("#")) continue; // Пропускаем комментарии

                // Если строка не начинается с пробела (или таба) и содержит ':' и это не строка продолжения многострочного текста (|)
                // Это эвристика для определения новой секции YAML
                if (!line.startsWith(" ") && !line.startsWith("\t") && trimmedLine.includes(":") && !trimmedLine.startsWith("|")) {
                    // console.log(`[isInScenarioTextBlock] New YAML section found: '${trimmedLine}'. Exiting block.`);
                    return false; // Нашли новую секцию YAML, значит мы уже не в "ТекстСценария:"
                }
            }
            // console.log("[isInScenarioTextBlock] Cursor is within 'ТекстСценария:' block.");
            return true; // Если новых секций не найдено, считаем, что мы в блоке
        }
        return false;
    }

    /**
     * Нормализует переносы строк, удаляя лишние пустые строки
     */
    private normalizeLineBreaks(text: string): string {
        return text.replace(/\n\s*\n/g, '\n').trim();
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

    private getScenarioParameterDefaults(document: vscode.TextDocument): Map<string, string> {
        const key = document.uri.toString();
        const cached = this.scenarioDefaultsByDocument.get(key);
        if (cached && cached.version === document.version) {
            return cached.defaults;
        }

        const defaults = parseScenarioParameterDefaults(document.getText());
        this.scenarioDefaultsByDocument.set(key, {
            version: document.version,
            defaults
        });
        return defaults;
    }

    private buildScenarioCallInsertText(
        scenarioName: string,
        lineIndent: string,
        firstLinePrefix: string,
        defaults: Map<string, string>,
        scenarioCallKeyword: string
    ): string | vscode.SnippetString {
        if (!scenarioName) {
            return `${firstLinePrefix}${scenarioCallKeyword} `;
        }

        const params = this.scenarioParametersByName.get(scenarioName) || [];
        if (params.length === 0) {
            return `${firstLinePrefix}${scenarioCallKeyword} ${scenarioName}`;
        }

        const maxParamLength = params.reduce((max, param) => Math.max(max, param.length), 0);
        const paramIndent = firstLinePrefix.length > 0 ? `${lineIndent}    ` : '    ';
        let snippetText = `${firstLinePrefix}${scenarioCallKeyword} ${scenarioName}`;
        let paramIndex = 1;

        params.forEach(paramName => {
            const alignedName = paramName.padEnd(maxParamLength, ' ');
            const calledScenarioDefaults = this.calledScenarioDefaultsByName.get(scenarioName);
            const defaultValue = calledScenarioDefaults?.get(paramName) ?? defaults.get(paramName) ?? `"${paramName}"`;
            const escapedDefault = this.escapeSnippetDefaultValue(defaultValue);
            snippetText += `\n${paramIndent}${alignedName} = \${${paramIndex++}:${escapedDefault}}`;
        });

        return new vscode.SnippetString(snippetText);
    }

    private escapeSnippetDefaultValue(value: string): string {
        return value
            .replace(/\\/g, '\\\\')
            .replace(/\$/g, '\\$')
            .replace(/\}/g, '\\}');
    }
}
