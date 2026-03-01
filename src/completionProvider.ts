import * as vscode from 'vscode';
import { parse } from 'node-html-parser';
import { getStepsHtml, forceRefreshSteps as forceRefreshStepsCore } from './stepsFetcher';
import { TestInfo } from './types';
import { getTranslator } from './localization';
import { parseScenarioParameterDefaults } from './scenarioParameterUtils';
import { ScenarioLanguage, getScenarioCallKeyword, getScenarioLanguageForDocument } from './gherkinLanguage';
import { YamlParametersManager } from './yamlParametersManager';

const VARIABLE_REFERENCE_PREFIX_REGEX = /^[A-Za-zА-Яа-яЁё0-9_]*$/;
const SEMANTIC_STEP_PREFIX = '!';
const GHERKIN_KEYWORD_PREFIX_REGEX = /^(?:\*\s*)?(?:and|but|then|when|given|if|и|тогда|когда|если|допустим|к тому же|но)\s+/i;
const SEMANTIC_SYNONYM_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
    ['нажать', 'нажатие', 'нажатия', 'нажат', 'кликнуть', 'клик', 'щелкнуть', 'щелчок', 'click', 'clicking', 'press', 'pressing', 'tap'],
    ['кнопка', 'button'],
    ['окно', 'форма', 'window', 'form'],
    ['поле', 'реквизит', 'атрибут', 'field', 'attribute'],
    ['ввести', 'ввод', 'input', 'enter', 'type'],
    ['проверить', 'проверка', 'check', 'verify', 'assert'],
    ['открыть', 'открывается', 'open', 'opened'],
    ['закрыть', 'закрывается', 'close', 'closed'],
    ['выбрать', 'выбор', 'select', 'choose', 'pick'],
    ['таблица', 'список', 'table', 'list', 'grid'],
    ['команда', 'действие', 'command', 'action'],
    ['перейти', 'открыть', 'go', 'move', 'navigate'],
    ['сохранить', 'запомнить', 'save', 'store', 'remember'],
    ['значение', 'параметр', 'value', 'parameter', 'argument']
];
const SAVE_VARIABLE_STEP_REGEX_EN = /^\s*(?:(?:\*\s*)?(?:And|Then|When|Given|But|И|Тогда|Когда|Если|Допустим|К тому же|Но)\s+)?I\s+save\s+(.+?)\s+in\s+(?:"([^"]+)"|'([^']+)')\s+variable\s*$/i;
const SAVE_VARIABLE_STEP_REGEX_EN_VALUE_TO = /^\s*(?:(?:\*\s*)?(?:And|Then|When|Given|But|И|Тогда|Когда|Если|Допустим|К тому же|Но)\s+)?I\s+save\s+(.+?)\s+value\s+to\s+(?:"([^"]+)"|'([^']+)')\s+variable\s*$/i;
const SAVE_VARIABLE_STEP_REGEX_RU = /^\s*(?:(?:\*\s*)?(?:And|Then|When|Given|But|И|Тогда|Когда|Если|Допустим|К тому же|Но)\s+)?Я\s+запоминаю\s+значение\s+выражения\s+(.+?)\s+в\s+переменную\s+(?:"([^"]+)"|'([^']+)')\s*$/i;
const SAVE_VARIABLE_STEP_REGEX_RU_VALUE_TO = /^\s*(?:(?:\*\s*)?(?:And|Then|When|Given|But|И|Тогда|Когда|Если|Допустим|К тому же|Но)\s+)?Я\s+запоминаю\s+в\s+переменную\s+(?:"([^"]+)"|'([^']+)')\s+значение\s+(.+?)\s*$/i;

function normalizeSemanticSynonymToken(value: string): string {
    return value.trim().toLocaleLowerCase().replace(/ё/g, 'е');
}

function buildSemanticSynonymIndex(
    groups: ReadonlyArray<ReadonlyArray<string>>
): Map<string, string[]> {
    const index = new Map<string, Set<string>>();

    groups.forEach(group => {
        const normalizedGroup = Array.from(new Set(
            group
                .map(token => normalizeSemanticSynonymToken(token))
                .filter(token => token.length >= 2)
        ));
        if (normalizedGroup.length < 2) {
            return;
        }

        normalizedGroup.forEach(token => {
            const bucket = index.get(token) || new Set<string>();
            normalizedGroup.forEach(value => bucket.add(value));
            index.set(token, bucket);
        });
    });

    const result = new Map<string, string[]>();
    index.forEach((values, key) => {
        result.set(key, Array.from(values.values()));
    });
    return result;
}

const SEMANTIC_SYNONYM_INDEX = buildSemanticSynonymIndex(SEMANTIC_SYNONYM_GROUPS);

interface SavedVariableDefinition {
    name: string;
    value: string;
    source: 'saved' | 'global';
}

interface SemanticStepEntry {
    item: vscode.CompletionItem;
    itemText: string;
    stepSearchText: string;
    descriptionSearchText: string;
    tokens: string[];
    tokenSet: Set<string>;
    semanticNorm: number;
    language: ScenarioLanguage;
}

export class DriveCompletionProvider implements vscode.CompletionItemProvider {
    private gherkinCompletionItems: vscode.CompletionItem[] = [];
    private semanticStepEntries: SemanticStepEntry[] = [];
    private semanticIdfByTerm = new Map<string, number>();
    private semanticPostingsByTerm = new Map<string, number[]>();
    private semanticTermsByPrefix = new Map<string, string[]>();
    private semanticVectorScoreCache = new Map<string, Map<number, number>>();
    private gherkinItemLanguageByItem = new WeakMap<vscode.CompletionItem, ScenarioLanguage>();
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
        this.semanticStepEntries = [];
        this.semanticIdfByTerm.clear();
        this.semanticPostingsByTerm.clear();
        this.semanticTermsByPrefix.clear();
        this.semanticVectorScoreCache.clear();
        this.gherkinItemLanguageByItem = new WeakMap<vscode.CompletionItem, ScenarioLanguage>();
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
        this.semanticStepEntries = [];
        this.semanticIdfByTerm.clear();
        this.semanticPostingsByTerm.clear();
        this.semanticTermsByPrefix.clear();
        this.semanticVectorScoreCache.clear();
        this.gherkinItemLanguageByItem = new WeakMap<vscode.CompletionItem, ScenarioLanguage>();
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
                    this.gherkinItemLanguageByItem.set(russianItem, 'ru');
                    this.gherkinCompletionItems.push(russianItem);
                    this.semanticStepEntries.push(this.createSemanticStepEntry(
                        russianItem,
                        russianStepText,
                        russianStepDescription,
                        [stepText, stepDescription],
                        'ru'
                    ));
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
                    this.gherkinItemLanguageByItem.set(item, 'en');
                    this.gherkinCompletionItems.push(item);
                    this.semanticStepEntries.push(this.createSemanticStepEntry(
                        item,
                        stepText,
                        stepDescription,
                        [russianStepText, russianStepDescription],
                        'en'
                    ));
                }
            }
        });
        this.rebuildSemanticVectorIndex();
        console.log(`[DriveCompletionProvider] Parsed and stored ${this.gherkinCompletionItems.length} Gherkin completion items and ${this.semanticStepEntries.length} semantic entries.`);
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
                this.semanticStepEntries = [];
                this.semanticIdfByTerm.clear();
                this.semanticPostingsByTerm.clear();
                this.semanticTermsByPrefix.clear();
                this.semanticVectorScoreCache.clear();
                this.gherkinItemLanguageByItem = new WeakMap<vscode.CompletionItem, ScenarioLanguage>();
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

        const isFeatureDocument = this.isFeatureDocument(document);
        let isSupportedDocument = isFeatureDocument;
        if (!isSupportedDocument) {
            const { isScenarioYamlFile } = await import('./yamlValidator.js');
            isSupportedDocument = isScenarioYamlFile(document);
        }
        if (!isSupportedDocument) {
            console.log("[DriveCompletionProvider:provideCompletionItems] Unsupported document type. Returning empty.");
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
            return await this.buildSavedVariableCompletionList(document, position, variableReferenceContext);
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
        const lineStartPattern = /^(\s*)(?:\*\s*)?(and|but|then|when|given|if|и|тогда|когда|если|допустим|к тому же|но)?\s*/i;
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
        const rawTextToMatch = keywordInLine ? userTextAfterKeyword : userTextAfterIndentation;
        const textToMatchAgainst = rawTextToMatch.replace(/^\*\s*/, '');
        const scenarioLanguage = getScenarioLanguageForDocument(document);
        const scenarioCallKeyword = getScenarioCallKeyword(scenarioLanguage);
        const semanticQuery = this.extractSemanticStepQuery(textToMatchAgainst);
        if (semanticQuery !== null) {
            return this.buildSemanticStepCompletionList(
                position,
                indentation,
                semanticQuery,
                textToMatchAgainst,
                scenarioLanguage
            );
        }

        console.log(`[DriveCompletionProvider:provideCompletionItems] Indent: '${indentation}', KeywordInLine: '${keywordInLine}', UserTextAfterKeyword: '${userTextAfterKeyword}', UserTextAfterIndentation: '${userTextAfterIndentation}'`);

        // Добавляем Gherkin шаги
        this.gherkinCompletionItems.forEach(baseItem => {
            const itemFullText = typeof baseItem.label === 'string' ? baseItem.label : baseItem.label.label; // Полный текст элемента автодополнения

            // Извлекаем ключевое слово из самого шага Gherkin, если оно там есть
            const itemStartPatternGherkin = /^(And|But|Then|When|Given|If|Но|Тогда|Когда|Если|И|К тому же|Допустим)\s+/i;
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
                const itemLanguage = this.getStepLanguageForItem(baseItem);
                const languageBucket = itemLanguage && itemLanguage !== scenarioLanguage ? '1' : '0';
                completionItem.sortText = `0${languageBucket}${(1 - matchResult.score).toFixed(3)}${itemFullText}`;
                completionList.items.push(completionItem);
            }
        });

        // Добавляем вызовы сценариев
        // Текст, который пользователь ввел после отступа, очищенный от возможного "And " в начале
        const textForScenarioFuzzyMatch = userTextAfterIndentation.replace(/^(And|И|Допустим)\s+/i, '');
        const scenarioParameterDefaults = this.getScenarioParameterDefaults(document);
        console.log(`[DriveCompletionProvider:provideCompletionItems] Text for scenario fuzzy match: '${textForScenarioFuzzyMatch}' (based on userTextAfterIndentation: '${userTextAfterIndentation}')`);

        if (!isFeatureDocument) {
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
        }

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

    private async buildSavedVariableCompletionList(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: { startCharacter: number; typedPrefix: string }
    ): Promise<vscode.CompletionList> {
        const completionList = new vscode.CompletionList([], false);
        const savedVariables = this.collectSavedVariableDefinitionsBeforeLine(document, position.line);
        const globalVariables = await this.collectGlobalVariableDefinitions();
        const allVariables = this.mergeVariableDefinitions(savedVariables, globalVariables);

        if (allVariables.length === 0) {
            return completionList;
        }

        const typedPrefixLower = context.typedPrefix.toLocaleLowerCase();
        const filteredVariables = allVariables.filter(variable => {
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
            const preview = this.buildSavedVariableValuePreview(variable.value);
            completionItem.detail = variable.source === 'global'
                ? vscode.l10n.t('Global variable: {0}', preview)
                : vscode.l10n.t('Saved variable: {0}', preview);
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

    private async collectGlobalVariableDefinitions(): Promise<SavedVariableDefinition[]> {
        try {
            const manager = YamlParametersManager.getInstance(this.context);
            const globalVariables = await manager.loadGlobalVanessaVariables();
            return globalVariables
                .map(variable => ({
                    name: (variable.key || '').trim(),
                    value: typeof variable.value === 'string' ? variable.value : String(variable.value ?? ''),
                    source: 'global' as const
                }))
                .filter(variable => variable.name.length > 0);
        } catch (error) {
            console.warn('[DriveCompletionProvider] Failed to load GlobalVars for variable completion:', error);
            return [];
        }
    }

    private mergeVariableDefinitions(
        savedVariables: SavedVariableDefinition[],
        globalVariables: SavedVariableDefinition[]
    ): SavedVariableDefinition[] {
        const merged: SavedVariableDefinition[] = [];
        const seen = new Set<string>();

        savedVariables.forEach(variable => {
            const normalized = variable.name.toLocaleLowerCase();
            if (seen.has(normalized)) {
                return;
            }
            seen.add(normalized);
            merged.push(variable);
        });

        globalVariables.forEach(variable => {
            const normalized = variable.name.toLocaleLowerCase();
            if (seen.has(normalized)) {
                return;
            }
            seen.add(normalized);
            merged.push(variable);
        });

        return merged;
    }

    private extractSavedVariableFromStepLine(lineText: string): SavedVariableDefinition | null {
        const englishExpressionMatch = lineText.match(SAVE_VARIABLE_STEP_REGEX_EN);
        if (englishExpressionMatch) {
            const variableName = (englishExpressionMatch[2] || englishExpressionMatch[3] || '').trim();
            if (!variableName) {
                return null;
            }
            return {
                name: variableName,
                value: (englishExpressionMatch[1] || '').trim(),
                source: 'saved'
            };
        }

        const englishValueToMatch = lineText.match(SAVE_VARIABLE_STEP_REGEX_EN_VALUE_TO);
        if (englishValueToMatch) {
            const variableName = (englishValueToMatch[2] || englishValueToMatch[3] || '').trim();
            if (!variableName) {
                return null;
            }
            return {
                name: variableName,
                value: (englishValueToMatch[1] || '').trim(),
                source: 'saved'
            };
        }

        const russianExpressionMatch = lineText.match(SAVE_VARIABLE_STEP_REGEX_RU);
        if (russianExpressionMatch) {
            const variableName = (russianExpressionMatch[2] || russianExpressionMatch[3] || '').trim();
            if (!variableName) {
                return null;
            }
            return {
                name: variableName,
                value: (russianExpressionMatch[1] || '').trim(),
                source: 'saved'
            };
        }

        const russianValueToMatch = lineText.match(SAVE_VARIABLE_STEP_REGEX_RU_VALUE_TO);
        if (russianValueToMatch) {
            const variableName = (russianValueToMatch[1] || russianValueToMatch[2] || '').trim();
            if (!variableName) {
                return null;
            }
            return {
                name: variableName,
                value: (russianValueToMatch[3] || '').trim(),
                source: 'saved'
            };
        }

        return null;
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

    private createSemanticStepEntry(
        item: vscode.CompletionItem,
        stepText: string,
        primaryDescription: string,
        relatedTexts: string[] = [],
        language: ScenarioLanguage = 'en'
    ): SemanticStepEntry {
        const normalizedStepText = this.normalizeSemanticSearchText(stepText);
        const normalizedDescriptionText = this.normalizeSemanticSearchText(
            [primaryDescription, ...relatedTexts].filter(Boolean).join(' ')
        );
        const tokens = Array.from(new Set(
            this.extractSemanticSearchTokens(`${normalizedStepText} ${normalizedDescriptionText}`)
        ));

        return {
            item,
            itemText: stepText,
            stepSearchText: normalizedStepText,
            descriptionSearchText: normalizedDescriptionText,
            tokens,
            tokenSet: new Set(tokens),
            semanticNorm: 0,
            language
        };
    }

    private getStepLanguageForItem(item: vscode.CompletionItem): ScenarioLanguage | null {
        return this.gherkinItemLanguageByItem.get(item) || null;
    }

    private rebuildSemanticVectorIndex(): void {
        this.semanticIdfByTerm.clear();
        this.semanticPostingsByTerm.clear();
        this.semanticTermsByPrefix.clear();
        this.semanticVectorScoreCache.clear();

        const totalDocuments = this.semanticStepEntries.length;
        if (totalDocuments === 0) {
            return;
        }

        const documentFrequencyByTerm = new Map<string, number>();
        this.semanticStepEntries.forEach(entry => {
            const uniqueTerms = new Set(entry.tokens);
            uniqueTerms.forEach(term => {
                documentFrequencyByTerm.set(term, (documentFrequencyByTerm.get(term) || 0) + 1);
            });
        });

        documentFrequencyByTerm.forEach((documentFrequency, term) => {
            const idf = Math.log((1 + totalDocuments) / (1 + documentFrequency)) + 1;
            this.semanticIdfByTerm.set(term, idf);
        });

        const prefixBuckets = new Map<string, Set<string>>();
        this.semanticIdfByTerm.forEach((_idf, term) => {
            const maxPrefixLength = Math.min(6, term.length);
            for (let prefixLength = 2; prefixLength <= maxPrefixLength; prefixLength++) {
                const prefix = term.slice(0, prefixLength);
                const bucket = prefixBuckets.get(prefix) || new Set<string>();
                bucket.add(term);
                prefixBuckets.set(prefix, bucket);
            }
        });
        prefixBuckets.forEach((bucket, prefix) => {
            this.semanticTermsByPrefix.set(prefix, Array.from(bucket.values()));
        });

        this.semanticStepEntries.forEach((entry, entryIndex) => {
            const uniqueTerms = new Set(entry.tokens);
            let normSquared = 0;

            uniqueTerms.forEach(term => {
                const idf = this.semanticIdfByTerm.get(term);
                if (!idf) {
                    return;
                }

                normSquared += idf * idf;

                const postings = this.semanticPostingsByTerm.get(term) || [];
                postings.push(entryIndex);
                this.semanticPostingsByTerm.set(term, postings);
            });

            entry.semanticNorm = normSquared > 0 ? Math.sqrt(normSquared) : 0;
        });
    }

    private normalizeSemanticSearchText(text: string): string {
        return text
            .replace(/\r\n|\r/g, '\n')
            .replace(/"%\d+\s+[^"]*"|'%\d+\s+[^']*'/g, ' ')
            .replace(/\[[^\]]+\]/g, ' ')
            .replace(/[_:;,.!?(){}[\]"'`~@#$%^&*+=\\/|-]/g, ' ')
            .replace(GHERKIN_KEYWORD_PREFIX_REGEX, '')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/ё/g, 'е')
            .toLocaleLowerCase();
    }

    private stemSemanticToken(token: string): string {
        let stem = token.toLocaleLowerCase().replace(/ё/g, 'е');
        if (stem.length < 4) {
            return stem;
        }

        // Lightweight EN stemming.
        const englishSuffixes = ['ings', 'ing', 'edly', 'ed', 'ies', 'es', 's'];
        for (const suffix of englishSuffixes) {
            if (stem.length > suffix.length + 2 && stem.endsWith(suffix)) {
                stem = stem.slice(0, -suffix.length);
                break;
            }
        }

        // Lightweight RU stemming for frequent inflection endings.
        const russianLongSuffixes = [
            'иями', 'ями', 'ами', 'ого', 'ему', 'ому', 'ыми', 'ими', 'ого', 'его',
            'аться', 'яться', 'иться', 'ться', 'ется', 'ится', 'лась', 'лись', 'лся'
        ];
        for (const suffix of russianLongSuffixes) {
            if (stem.length > suffix.length + 2 && stem.endsWith(suffix)) {
                stem = stem.slice(0, -suffix.length);
                return stem;
            }
        }

        const russianShortSuffixes = [
            'ов', 'ев', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях',
            'ый', 'ий', 'ой', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие',
            'ых', 'их', 'ую', 'юю', 'а', 'я', 'ы', 'и', 'о', 'е', 'у', 'ю'
        ];
        for (const suffix of russianShortSuffixes) {
            if (stem.length > suffix.length + 2 && stem.endsWith(suffix)) {
                stem = stem.slice(0, -suffix.length);
                break;
            }
        }

        return stem;
    }

    private extractSemanticSearchTokens(text: string): string[] {
        const tokens = this.normalizeSemanticSearchText(text)
            .split(/\s+/)
            .map(token => token.trim())
            .filter(token => token.length >= 2);

        const result = new Set<string>();
        for (const token of tokens) {
            result.add(token);
            const stem = this.stemSemanticToken(token);
            if (stem && stem.length >= 2) {
                result.add(stem);
            }
            this.appendSemanticSynonyms(result, token);
            if (stem && stem.length >= 2) {
                this.appendSemanticSynonyms(result, stem);
            }
        }

        return Array.from(result.values());
    }

    private appendSemanticSynonyms(target: Set<string>, token: string): void {
        const normalizedToken = normalizeSemanticSynonymToken(token);
        if (!normalizedToken || normalizedToken.length < 2) {
            return;
        }

        const synonyms = SEMANTIC_SYNONYM_INDEX.get(normalizedToken);
        if (!synonyms || synonyms.length === 0) {
            return;
        }

        synonyms.forEach(value => {
            if (!value || value.length < 2) {
                return;
            }
            target.add(value);
            const stem = this.stemSemanticToken(value);
            if (stem && stem.length >= 2) {
                target.add(stem);
            }
        });
    }

    private extractSemanticStepQuery(input: string): string | null {
        const trimmed = input.trimStart();
        if (!trimmed.startsWith(SEMANTIC_STEP_PREFIX)) {
            return null;
        }
        return trimmed.substring(SEMANTIC_STEP_PREFIX.length).trim();
    }

    private calculateSemanticVectorScores(queryTokens: string[]): Map<number, number> {
        const cacheKey = queryTokens.join(' ');
        const cached = this.semanticVectorScoreCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const scoresByEntry = new Map<number, number>();
        if (queryTokens.length === 0 || this.semanticStepEntries.length === 0 || this.semanticIdfByTerm.size === 0) {
            return scoresByEntry;
        }

        const weightedQueryTerms = new Map<string, number>();
        const uniqueQueryTerms = Array.from(new Set(queryTokens));

        uniqueQueryTerms.forEach(term => {
            if (!term || term.length < 2) {
                return;
            }

            const hasExactTerm = this.semanticIdfByTerm.has(term);
            if (this.semanticIdfByTerm.has(term)) {
                weightedQueryTerms.set(term, Math.max(weightedQueryTerms.get(term) || 0, 1));
            }

            if (term.length >= 3) {
                const prefixKey = term.slice(0, Math.min(6, term.length));
                const prefixCandidates = this.semanticTermsByPrefix.get(prefixKey) || [];
                let added = 0;
                for (const candidate of prefixCandidates) {
                    if (!candidate.startsWith(term) || candidate === term) {
                        continue;
                    }
                    const expansionWeight = hasExactTerm ? 0.35 : 0.6;
                    weightedQueryTerms.set(candidate, Math.max(weightedQueryTerms.get(candidate) || 0, expansionWeight));
                    added++;
                    if (added >= 24) {
                        break;
                    }
                }
            }
        });

        if (weightedQueryTerms.size === 0) {
            return scoresByEntry;
        }

        let queryNormSquared = 0;
        weightedQueryTerms.forEach((queryWeight, term) => {
            const idf = this.semanticIdfByTerm.get(term) || 0;
            if (idf <= 0 || queryWeight <= 0) {
                return;
            }

            const queryTermWeight = queryWeight * idf;
            queryNormSquared += queryTermWeight * queryTermWeight;

            const dotContribution = queryTermWeight * idf;
            const postings = this.semanticPostingsByTerm.get(term) || [];
            for (const entryIndex of postings) {
                scoresByEntry.set(entryIndex, (scoresByEntry.get(entryIndex) || 0) + dotContribution);
            }
        });

        if (queryNormSquared <= 0) {
            return new Map<number, number>();
        }

        const queryNorm = Math.sqrt(queryNormSquared);
        const cosineScores = new Map<number, number>();

        scoresByEntry.forEach((dotProduct, entryIndex) => {
            const entryNorm = this.semanticStepEntries[entryIndex]?.semanticNorm || 0;
            if (entryNorm <= 0) {
                return;
            }
            const cosineScore = dotProduct / (queryNorm * entryNorm);
            if (cosineScore > 0) {
                cosineScores.set(entryIndex, Math.min(1, cosineScore));
            }
        });

        this.semanticVectorScoreCache.set(cacheKey, cosineScores);
        if (this.semanticVectorScoreCache.size > 300) {
            const firstKey = this.semanticVectorScoreCache.keys().next().value;
            if (typeof firstKey === 'string') {
                this.semanticVectorScoreCache.delete(firstKey);
            }
        }

        return cosineScores;
    }

    private getSemanticStepScore(
        entry: SemanticStepEntry,
        normalizedQuery: string,
        queryTokens: string[],
        vectorScore: number
    ): number {
        if (!normalizedQuery) {
            return 0.2;
        }

        const stepMatch = this.fuzzyMatch(entry.stepSearchText, normalizedQuery);
        const descriptionMatch = this.fuzzyMatch(entry.descriptionSearchText, normalizedQuery);
        const bestFuzzy = Math.max(stepMatch.score, descriptionMatch.score * 1.15);

        let tokenScore = 0;
        if (queryTokens.length > 0 && entry.tokenSet.size > 0) {
            const uniqueQueryTerms = new Set(queryTokens.filter(term => term.length >= 2));
            const matchableQueryTerms = new Set<string>();
            uniqueQueryTerms.forEach(term => {
                if (entry.tokenSet.has(term) || this.semanticIdfByTerm.has(term)) {
                    matchableQueryTerms.add(term);
                    return;
                }

                if (term.length < 3) {
                    return;
                }
                const prefixKey = term.slice(0, Math.min(6, term.length));
                const prefixCandidates = this.semanticTermsByPrefix.get(prefixKey) || [];
                if (prefixCandidates.some(candidate => candidate.startsWith(term) && candidate !== term)) {
                    matchableQueryTerms.add(term);
                }
            });

            const denominator = matchableQueryTerms.size > 0 ? matchableQueryTerms.size : uniqueQueryTerms.size;
            let matchedTokens = 0;
            uniqueQueryTerms.forEach(term => {
                if (entry.tokenSet.has(term)) {
                    matchedTokens++;
                }
            });
            tokenScore = denominator > 0 ? matchedTokens / denominator : 0;
        }

        const containsPhrase =
            entry.stepSearchText.includes(normalizedQuery) ||
            entry.descriptionSearchText.includes(normalizedQuery);

        let score = bestFuzzy * 0.4 + tokenScore * 0.35 + vectorScore * 0.75;
        if (containsPhrase) {
            score += 0.1;
        }

        return Math.min(1, score);
    }

    private buildSemanticStepCompletionList(
        position: vscode.Position,
        indentation: string,
        semanticQuery: string,
        typedSemanticInput: string,
        preferredLanguage: ScenarioLanguage
    ): vscode.CompletionList {
        // Re-query semantic results as user types so relevance does not depend on
        // whether a trailing space/trigger character was entered.
        const completionList = new vscode.CompletionList([], true);
        if (this.semanticStepEntries.length === 0) {
            return completionList;
        }

        const normalizedQuery = this.normalizeSemanticSearchText(semanticQuery);
        const queryTokens = this.extractSemanticSearchTokens(normalizedQuery);
        const vectorScores = this.calculateSemanticVectorScores(queryTokens);
        const rawFilterKey = (typedSemanticInput || '').trim();
        const normalizedFilterKey = this.normalizeSemanticSearchText(rawFilterKey);

        const candidateIndices = new Set<number>();
        if (!normalizedQuery) {
            for (let index = 0; index < Math.min(60, this.semanticStepEntries.length); index++) {
                candidateIndices.add(index);
            }
        } else {
            vectorScores.forEach((_score, entryIndex) => {
                candidateIndices.add(entryIndex);
            });

            if (candidateIndices.size === 0) {
                this.semanticStepEntries.forEach((entry, entryIndex) => {
                    if (entry.stepSearchText.includes(normalizedQuery) || entry.descriptionSearchText.includes(normalizedQuery)) {
                        candidateIndices.add(entryIndex);
                    }
                });
            }

            if (candidateIndices.size === 0) {
                for (let index = 0; index < Math.min(120, this.semanticStepEntries.length); index++) {
                    candidateIndices.add(index);
                }
            }
        }

        const ranked = Array.from(candidateIndices.values())
            .map(entryIndex => {
                const entry = this.semanticStepEntries[entryIndex];
                return {
                    entryIndex,
                    entry,
                    languageBucket: entry.language === preferredLanguage ? 0 : 1,
                    score: this.getSemanticStepScore(
                        entry,
                        normalizedQuery,
                        queryTokens,
                        vectorScores.get(entryIndex) || 0
                    )
                };
            })
            .filter(item => item.languageBucket === 0)
            .filter(item => normalizedQuery.length === 0 || item.score >= 0.2)
            .sort((left, right) => {
                return right.score - left.score;
            })
            .slice(0, 20);

        ranked.forEach((result, index) => {
            const baseItem = result.entry.item;
            const itemFullText = result.entry.itemText;
            const completionItem = new vscode.CompletionItem(itemFullText, baseItem.kind);
            completionItem.documentation = baseItem.documentation;
            completionItem.detail = baseItem.detail
                ? `${baseItem.detail} · ${vscode.l10n.t('semantic match')}`
                : vscode.l10n.t('semantic match');

            const replacementRange = new vscode.Range(
                position.line,
                indentation.length,
                position.line,
                position.character
            );
            completionItem.range = replacementRange;
            completionItem.insertText = typeof baseItem.insertText === 'string'
                ? baseItem.insertText
                : itemFullText;
            completionItem.filterText = [
                rawFilterKey,
                normalizedFilterKey,
                normalizedQuery,
                result.entry.stepSearchText,
                result.entry.descriptionSearchText,
                itemFullText
            ].filter(Boolean).join(' ');
            completionItem.sortText = `0${result.languageBucket}${(1 - result.score).toFixed(4)}_${index.toString().padStart(2, '0')}`;
            completionList.items.push(completionItem);
        });

        return completionList;
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
        if (this.isFeatureDocument(document)) {
            return this.isInFeatureScenarioBlock(document, position.line);
        }

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

    private isFeatureDocument(document: vscode.TextDocument): boolean {
        return document.fileName.toLowerCase().endsWith('.feature');
    }

    private isInFeatureScenarioBlock(document: vscode.TextDocument, lineIndex: number): boolean {
        const currentLine = document.lineAt(lineIndex).text.trim();
        if (currentLine.startsWith('#')) {
            return false;
        }
        if (currentLine.startsWith('@') || currentLine.startsWith('|') || currentLine.startsWith('"""')) {
            return false;
        }
        if (/^(?:Feature|Функционал|Rule|Правило|Scenario|Сценарий|Scenario Outline|Структура сценария|Examples|Примеры|Scenarios|Сценарии)\s*:/i.test(currentLine)) {
            return false;
        }

        for (let line = lineIndex; line >= 0; line--) {
            const trimmed = document.lineAt(line).text.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@')) {
                continue;
            }

            if (/^(?:Scenario|Сценарий|Scenario Outline|Структура сценария|Background|Предыстория)\s*:/i.test(trimmed)) {
                return true;
            }

            if (/^(?:Feature|Функционал|Rule|Правило|Examples|Примеры)\s*:?/i.test(trimmed)) {
                return false;
            }
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
