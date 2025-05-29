import * as vscode from 'vscode';
import { parse } from 'node-html-parser';
import { getStepsHtml, forceRefreshSteps as forceRefreshStepsCore } from './stepsFetcher';
import { TestInfo } from './types'; 

export class DriveCompletionProvider implements vscode.CompletionItemProvider {
    private gherkinCompletionItems: vscode.CompletionItem[] = [];
    private scenarioCompletionItems: vscode.CompletionItem[] = []; 
    private isLoadingGherkin: boolean = false;
    private loadingGherkinPromise: Promise<void> | null = null;
    private context: vscode.ExtensionContext;
    
    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.loadGherkinCompletionItems().catch(err => { 
            console.error("[DriveCompletionProvider] Initial Gherkin load failed on constructor:", err.message);
            vscode.window.showErrorMessage(`Ошибка инициализации автодополнения Gherkin: ${err.message}`);
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
        console.log("[DriveCompletionProvider] Attempting to update scenario completions...");
        this.scenarioCompletionItems = [];
        if (!scenarios) {
            console.warn("[DriveCompletionProvider] Scenarios map is null. Scenario completions will be empty.");
            return;
        }
        if (scenarios.size === 0) {
            console.log("[DriveCompletionProvider] Received empty scenarios map. No scenario completions to update.");
            return;
        }

        scenarios.forEach((scenarioInfo, scenarioName) => {
            // Метка, которую увидит пользователь в списке автодополнения
            const displayLabel = `And ${scenarioName}`; 
            const item = new vscode.CompletionItem(displayLabel, vscode.CompletionItemKind.Function);
            
            item.detail = "Вложенный сценарий (1C:Drive)";
            item.documentation = new vscode.MarkdownString(`Вызвать сценарий "${scenarioName}".`);
            // Текст, по которому будет происходить фильтрация при вводе пользователя
            // (без "And ", чтобы можно было просто начать печатать имя сценария)
            item.filterText = scenarioName; 

            // Формируем SnippetString для вставки
            // Сниппет теперь ВСЕГДА начинается с "And "
            let snippetText = `And ${scenarioName}`; 
            if (scenarioInfo.parameters && scenarioInfo.parameters.length > 0) {
                const paramIndent = "    "; // Стандартный отступ для параметров
                let paramIndex = 1;
                // Параметры добавляются с новой строки с отступом
                scenarioInfo.parameters.forEach(paramName => {
                    // Формат вызова параметра: ИмяПараметра = "Значение"
                    snippetText += `\n${paramIndent}${paramName} = "\${${paramIndex++}:${paramName}Value}"`;
                });
            }
            item.insertText = new vscode.SnippetString(snippetText);
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
            // Убедимся, что есть хотя бы две ячейки (шаг и описание)
            if (cells.length >= 2) { 
                const stepText = cells[0].textContent.trim();
                const stepDescription = cells[1].textContent.trim();
                if (!stepText) return; // Пропускаем, если текст шага пуст
                
                // Создаем элемент автодополнения
                const item = new vscode.CompletionItem(stepText, vscode.CompletionItemKind.Snippet);
                item.documentation = new vscode.MarkdownString(stepDescription);
                item.detail = "Шаг Gherkin (1C:Drive)"; // Дополнительная информация о типе элемента
                // Используем оригинальный текст для вставки, т.к. он уже содержит плейсхолдеры %N
                item.insertText = stepText; 
                // "0" для приоритета, затем текст для алфавитной сортировки
                // item.sortText = "0" + stepText; // sortText будет формироваться в provideCompletionItems
                this.gherkinCompletionItems.push(item);
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
            .catch(error => {
                console.error(`[DriveCompletionProvider] Ошибка загрузки или парсинга steps.htm: ${error.message}`);
                vscode.window.showErrorMessage(`Не удалось загрузить шаги Gherkin для автодополнения: ${error.message}`);
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

        // Если элементы Gherkin еще не загружены или идет загрузка, дождемся ее завершения
        if (this.isLoadingGherkin && this.loadingGherkinPromise) {
            console.log("[DriveCompletionProvider:provideCompletionItems] Waiting for Gherkin load to complete...");
            await this.loadingGherkinPromise;
        } else if (this.gherkinCompletionItems.length === 0 && !this.isLoadingGherkin) {
            // Если загрузка Gherkin не идет, но элементов нет, попробуем загрузить
            console.log("[DriveCompletionProvider:provideCompletionItems] Gherkin items not loaded, attempting to load now...");
            await this.loadGherkinCompletionItems();
        }
        
        // Предоставляем автодополнение только в блоках текста сценария
        if (!this.isInScenarioTextBlock(document, position)) {
            console.log("[DriveCompletionProvider:provideCompletionItems] Not in scenario text block. Returning empty.");
            return [];
        }
        
        // Получаем текст текущей строки до позиции курсора
        const lineText = document.lineAt(position.line).text;
        const linePrefix = lineText.substring(0, position.character); // Текст строки до курсора
        
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
                const completionItem = new vscode.CompletionItem(baseItem.label, baseItem.kind);
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
                // insertText уже содержит полное определение шага, включая его Gherkin-слово
                completionItem.insertText = baseItem.insertText; 
                // Сортировка по релевантности
                completionItem.sortText = "0" + (1 - matchResult.score).toFixed(3) + itemFullText; // Используем toFixed(3) для большей гранулярности
                completionList.items.push(completionItem);
            }
        });

        // Добавляем вызовы сценариев
        // Текст, который пользователь ввел после отступа, очищенный от возможного "And " в начале
        const textForScenarioFuzzyMatch = userTextAfterIndentation.replace(/^(And|И|Допустим)\s+/i, '');
        console.log(`[DriveCompletionProvider:provideCompletionItems] Text for scenario fuzzy match: '${textForScenarioFuzzyMatch}' (based on userTextAfterIndentation: '${userTextAfterIndentation}')`);

        this.scenarioCompletionItems.forEach(baseScenarioItem => {
            // baseScenarioItem.filterText это "ИмяСценария"
            const matchResult = this.fuzzyMatch(baseScenarioItem.filterText || "", textForScenarioFuzzyMatch); 
            
            if (matchResult.matched) {
                const completionItem = new vscode.CompletionItem(baseScenarioItem.label, baseScenarioItem.kind); // label = "And ИмяСценария"
                completionItem.filterText = baseScenarioItem.filterText; // filterText = "ИмяСценария"
                completionItem.documentation = baseScenarioItem.documentation;
                completionItem.detail = baseScenarioItem.detail;
                
                // Диапазон для замены: от начала пользовательского ввода (после отступа) до текущей позиции курсора.
                const replacementRange = new vscode.Range(
                    position.line, 
                    indentation.length, // Начало текста после отступа
                    position.line, 
                    position.character 
                );
                completionItem.range = replacementRange;
                
                // baseScenarioItem.insertText это SnippetString вида "And ИмяСценария\n    Парам = ..."
                // Оно будет вставлено вместо всего, что пользователь напечатал после отступа.
                completionItem.insertText = baseScenarioItem.insertText; 

                completionItem.sortText = "1" + (1 - matchResult.score).toFixed(3) + (baseScenarioItem.filterText || ""); // Используем toFixed(3)
                console.log(`[Scenario Autocomplete] Label: "${completionItem.label}", Scenario Name: ${baseScenarioItem.filterText}, Input: "${textForScenarioFuzzyMatch}", Score: ${matchResult.score.toFixed(3)}, SortText: ${completionItem.sortText}`);
                completionList.items.push(completionItem);
            }
        });
        
        console.log(`[DriveCompletionProvider:provideCompletionItems] Total Gherkin items: ${this.gherkinCompletionItems.length}, Total Scenario items: ${this.scenarioCompletionItems.length}, Proposed items: ${completionList.items.length}`);
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
}