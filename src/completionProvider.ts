import * as vscode from 'vscode';
// import * as path from 'path'; // path больше не нужен здесь напрямую
// import * as fs from 'fs'; // fs больше не нужен здесь напрямую
import { parse } from 'node-html-parser';
import { getStepsHtml, forceRefreshSteps as forceRefreshStepsCore } from './stepsFetcher'; // Импортируем новую утилиту

export class DriveCompletionProvider implements vscode.CompletionItemProvider {
    private completionItems: vscode.CompletionItem[] = [];
    private isLoading: boolean = false;
    private loadingPromise: Promise<void> | null = null;
    private context: vscode.ExtensionContext;
    
    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.loadCompletionItems().catch(err => {
            console.error("[DriveCompletionProvider] Initial load failed on constructor:", err.message);
            vscode.window.showErrorMessage(`Ошибка инициализации автодополнения: ${err.message}`);
        });
    }

    // Метод для принудительного обновления, который может быть вызван из extension.ts
    public async refreshSteps(): Promise<void> {
        console.log("[DriveCompletionProvider] Refreshing steps triggered...");
        this.completionItems = []; // Очищаем старые элементы
        this.loadingPromise = null; // Сбрасываем промис загрузки
        this.isLoading = false;
        try {
            // Вызываем основную логику обновления из stepsFetcher
            const htmlContent = await forceRefreshStepsCore(this.context);
            this.parseAndStoreCompletionItems(htmlContent); // Парсим и сохраняем обновленные
            console.log("[DriveCompletionProvider] Steps refreshed and re-parsed successfully.");
        } catch (error: any) {
            console.error(`[DriveCompletionProvider] Failed to refresh steps: ${error.message}`);
            // Если принудительное обновление не удалось, пытаемся загрузить хоть что-то
            // чтобы расширение не осталось без автодополнения
            await this.loadCompletionItems();
        }
    }

    private parseAndStoreCompletionItems(htmlContent: string): void {
        this.completionItems = []; // Очищаем перед заполнением
        const root = parse(htmlContent);
        const rows = root.querySelectorAll('tr');
        
        rows.forEach(row => {
            const rowClass = row.classNames;
            if (!rowClass || !rowClass.startsWith('R')) {
                return;
            }
            
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2) {
                const stepText = cells[0].textContent.trim();
                const stepDescription = cells[1].textContent.trim();
                if (!stepText) return;
                this.createCompletionItem(stepText, stepDescription);
            }
        });
        console.log(`[DriveCompletionProvider] Parsed and stored ${this.completionItems.length} completion items.`);
    }


    private loadCompletionItems(): Promise<void> {
        if (this.isLoading && this.loadingPromise) {
            return this.loadingPromise;
        }
        
        // Если элементы уже загружены и нет активной загрузки, просто возвращаем
        if (this.completionItems.length > 0 && !this.isLoading) {
            return Promise.resolve();
        }
        
        this.isLoading = true;
        console.log("[DriveCompletionProvider] Starting to load completion items...");
        
        this.loadingPromise = getStepsHtml(this.context)
            .then(htmlContent => {
                this.parseAndStoreCompletionItems(htmlContent);
            })
            .catch(error => {
                console.error(`[DriveCompletionProvider] Ошибка загрузки или парсинга steps.htm: ${error.message}`);
                vscode.window.showErrorMessage(`Не удалось загрузить шаги для автодополнения: ${error.message}`);
                this.completionItems = []; // Убедимся, что список пуст в случае ошибки
            })
            .finally(() => {
                this.isLoading = false;
                // Не обнуляем loadingPromise здесь, чтобы повторные быстрые вызовы во время первой загрузки
                // все еще могли использовать его. Он будет сброшен принудительно при refreshSteps
                // или если completionItems пуст при следующем вызове loadCompletionItems.
                console.log("[DriveCompletionProvider] Finished loading attempt.");
            });
            
        return this.loadingPromise;
    }


    /**
     * Создает элемент автодополнения из шаблона шага и его описания
     */
    private createCompletionItem(stepText: string, stepDescription: string) {
        // Создаем элемент автодополнения
        const item = new vscode.CompletionItem(stepText, vscode.CompletionItemKind.Snippet);
        item.documentation = new vscode.MarkdownString(stepDescription);
        item.detail = "1C:Drive Test Step";
        item.sortText = "0" + stepText;
        this.completionItems.push(item);
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
        
        // Если ввод пустой, это совпадение, но с низкой оценкой
        if (!inputLower) {
            return { matched: true, score: 0.1 };
        }
        
        // Если ввод является подстрокой шаблона, это хорошее совпадение
        if (patternLower.includes(inputLower)) {
            // Более высокая оценка для совпадений в начале шаблона
            const startIndex = patternLower.indexOf(inputLower);
            const startScore = startIndex === 0 ? 1.0 : 0.8 - (startIndex / patternLower.length) * 0.2;
            return { matched: true, score: startScore };
        }
        
        // Проверяем, являются ли слова ввода подмножеством слов шаблона
        const patternWords = patternLower.split(/\s+/);
        const inputWords = inputLower.split(/\s+/).filter(word => word.length > 2);
        
        if (inputWords.length === 0) {
            return { matched: true, score: 0.1 };
        }
        
        let matchedWordCount = 0;
        for (const inputWord of inputWords) {
            for (const patternWord of patternWords) {
                if (patternWord.includes(inputWord)) {
                    matchedWordCount++;
                    break;
                }
            }
        }
        
        const matchRatio = matchedWordCount / inputWords.length;
        
        // Если хотя бы половина слов ввода найдена в шаблоне
        if (matchRatio >= 0.5) {
            return { matched: true, score: 0.5 + (matchRatio * 0.3) };
        }
        
        // Не очень хорошее совпадение
        return { matched: false, score: 0 };
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
        
        // Если элементы еще не загружены или идет загрузка, дождемся ее завершения
        if (this.isLoading && this.loadingPromise) {
            console.log("[DriveCompletionProvider:provideCompletionItems] Waiting for initial load to complete...");
            await this.loadingPromise;
        } else if (this.completionItems.length === 0 && !this.isLoading) {
            // Если загрузка не идет, но элементов нет, попробуем загрузить
            console.log("[DriveCompletionProvider:provideCompletionItems] Items not loaded, attempting to load now...");
            await this.loadCompletionItems();
        }

        // Если нет загруженных элементов, возвращаем пустой список
        if (this.completionItems.length === 0) {
            console.log("[DriveCompletionProvider:provideCompletionItems] No completion items available after load attempt.");
            return [];
        }
        
        // Предоставляем автодополнение только в блоках текста сценария
        if (!this.isInScenarioTextBlock(document, position)) {
            return [];
        }
        
        // Получаем текст текущей строки до позиции курсора
        const lineText = document.lineAt(position.line).text;
        const linePrefix = lineText.substring(0, position.character);
        
        // Создаем список автодополнения с правильной фильтрацией и заменой
        const completionList = new vscode.CompletionList();
        
        // Ищем отступы и ключевые слова в начале строки (регистронезависимо)
        const lineStartPattern = /^(\s*)(and|then|when|given)?\s*/i;
        const lineStartMatch = linePrefix.match(lineStartPattern);

        if (!lineStartMatch) {
            return completionList;
        }

        const indentation = lineStartMatch[1] || '';
        const keywordLower = lineStartMatch[2] ? lineStartMatch[2].toLowerCase() : '';
        const lineStart = lineStartMatch[0];

        // Текст, который пользователь ввел после отступов, ключевого слова и пробелов
        const userTextAfterLineStart = linePrefix.substring(lineStart.length);

        for (const baseItem of this.completionItems) {
            const itemText = baseItem.label.toString();
            
            // Разбиваем текст элемента на ключевое слово и остальную часть
            const itemStartPattern = /^(And|Then|When|Given)?\s*/i;
            const itemStartMatch = itemText.match(itemStartPattern);
            
            if (!itemStartMatch) {
                continue;
            }
            
            const itemKeywordLower = (itemStartMatch[1] || '').toLowerCase();
            const itemTextAfterKeyword = itemText.substring(itemStartMatch[0].length);
            
            // Если в строке есть ключевое слово, сопоставляем только элементы с тем же ключевым словом (без учета регистра)
            if (keywordLower && itemKeywordLower && keywordLower !== itemKeywordLower) {
                continue;
            }
            
            // Используем нечеткое сопоставление
            const matchResult = this.fuzzyMatch(itemTextAfterKeyword, userTextAfterLineStart);
            
            if (matchResult.matched) {
                const item = new vscode.CompletionItem(itemText, baseItem.kind);
                item.documentation = baseItem.documentation;
                item.detail = baseItem.detail;
                
                // Устанавливаем диапазон для замены всей строки
                const replacementRange = new vscode.Range(
                    position.line, 0,
                    position.line, position.character
                );
                item.range = replacementRange;
                
                // Используем оригинальный текст элемента (с правильным регистром)
                item.insertText = indentation + itemText;
                
                // Устанавливаем порядок сортировки на основе оценки совпадения
                item.sortText = (1 - matchResult.score).toFixed(2) + itemText;
                
                completionList.items.push(item);
            }
        }
        
        return completionList;
    }
    

    /**
     * Проверяет, находится ли позиция в блоке текста сценария
     */
    private isInScenarioTextBlock(document: vscode.TextDocument, position: vscode.Position): boolean {
        if (document.fileName.toLowerCase().endsWith('.yaml')) {
            // Более точная проверка: находимся ли мы ПОСЛЕ строки "ТекстСценария:"
            // и не в другой секции верхнего уровня.
            const textUpToPosition = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
            const scenarioBlockMatch = textUpToPosition.match(/ТекстСценария:\s*\|?\s*(\r\n|\r|\n)([\s\S]*)/);

            if (scenarioBlockMatch) {
                // Проверяем, что мы не попали в следующую секцию
                const textAfterPosition = document.getText(new vscode.Range(position, new vscode.Position(document.lineCount, 0)));
                const nextMajorSection = textAfterPosition.match(/^([А-ЯЁ][а-яё]+Сценария):/m); // Ищем следующую секцию типа "ПараметрыСценария:"
                
                if (nextMajorSection) {
                    // Если нашли следующую секцию, то мы все еще в блоке ТекстСценария
                    // если позиция курсора до этой следующей секции.
                    // Это более сложная проверка, для простоты пока оставим как есть.
                    // Главное, что мы после "ТекстСценария:".
                    return true;
                }
                // Если следующей секции нет, значит мы точно в блоке ТекстСценария (до конца файла)
                return true;
            }
            return false;
        }
        return false;
    }
}