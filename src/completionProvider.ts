import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parse } from 'node-html-parser';

export class DriveCompletionProvider implements vscode.CompletionItemProvider {
    private completionItems: vscode.CompletionItem[] = [];
    private isLoading: boolean = false;
    private loadingPromise: Promise<void> | null = null;
    
    constructor(private context: vscode.ExtensionContext) {
        // Запускаем загрузку данных сразу при создании
        this.loadCompletionItems();
    }

    private loadCompletionItems(): Promise<void> {
        // Если уже идёт загрузка, возвращаем существующий Promise
        if (this.isLoading && this.loadingPromise) {
            return this.loadingPromise;
        }
        
        if (this.completionItems.length > 0) {
        // Если элементы уже загружены, возвращаем resolved Promise
            return Promise.resolve();
        }
        
        this.isLoading = true;
        
        this.loadingPromise = new Promise<void>((resolve, reject) => {
            try {
                const tableFilePath = path.join(this.context.extensionPath, 'res', 'steps.htm');
                // Проверяем, существует ли файл
                if (!fs.existsSync(tableFilePath)) {
                    console.error(`[DriveCompletionProvider] Файл с шагами не найден ${tableFilePath}`);
                    this.isLoading = false;
                    reject(new Error('Таблица шагов не найдена'));
                    return;
                }
                
                const htmlContent = fs.readFileSync(tableFilePath, 'utf8');
                const root = parse(htmlContent);

                // Извлекаем строки из таблицы (все типы строк)
                const rows = root.querySelectorAll('tr');
                
                rows.forEach(row => {
                    // Пропускаем строки без нужных классов
                    const rowClass = row.classNames;
                    if (!rowClass || !rowClass.startsWith('R')) {
                        return;
                    }
                    
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 2) {
                        const stepText = cells[0].textContent.trim();
                        const stepDescription = cells[1].textContent.trim();
                        
                        // Пропускаем пустые шаги
                        if (!stepText) return;
                        
                        // Создаем элемент автодополнения
                        this.createCompletionItem(stepText, stepDescription);
                    }
                });
                
                console.log(`[DriveCompletionProvider] Загружено ${this.completionItems.length} элементов автодополнения`);
                this.isLoading = false;
                resolve();
            } catch (error) {
                console.error(`[DriveCompletionProvider] Ошибка загрузки элементов автодополнения: ${error}`);
                this.isLoading = false;
                reject(error);
            }
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
        item.sortText = "0" + stepText; // Сортировка элементов с префиксами первыми
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
        const inputWords = inputLower.split(/\s+/).filter(word => word.length > 2); // Ignore very short words
        
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
        // Убеждаемся, что элементы загружены
        try {
            await this.loadCompletionItems();
        } catch (error) {
            console.error(`[DriveCompletionProvider] Не удалось загрузить элементы автокомплита: ${error}`);
            return [];
        }

        // Если нет загруженных элементов, возвращаем пустой список
        if (this.completionItems.length === 0) {
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

        // Извлекаем части строки
        const indentation = lineStartMatch[1] || ''; // Отступы в начале
        const keywordLower = lineStartMatch[2] ? lineStartMatch[2].toLowerCase() : ''; // Переводим в нижний регистр для сравнения
        const spacesAfterKeyword = lineStartMatch[0].substring(indentation.length + (lineStartMatch[2] || '').length); // Пробелы после ключевого слова

        // Отступы + ключевое слово + пробелы после ключевого слова
        const lineStart = lineStartMatch[0];

        // Текст, который пользователь ввел после отступов, ключевого слова и пробелов
        const userTextAfterLineStart = linePrefix.substring(lineStart.length);

        // Откуда начинать замену (заменяем с начала строки)
        const replacementStartChar = 0; 

        for (const baseItem of this.completionItems) {
            const itemText = baseItem.label.toString();
            
            // Разбиваем текст элемента на ключевое слово и остальную часть
            const itemStartPattern = /^(And|Then|When|Given)?\s*/i;
            const itemStartMatch = itemText.match(itemStartPattern);
            
            if (!itemStartMatch) {
                continue;
            }
            
            const itemKeyword = itemStartMatch[1] || '';
            const itemKeywordLower = itemKeyword.toLowerCase();
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
        // Для YAML-файлов просто проверяем, является ли это yaml-файлом с расширением .yaml
        if (document.fileName.toLowerCase().endsWith('.yaml')) {
            const text = document.getText();
            return text.includes('ТекстСценария:');
        }
        return false;
    }
}