import * as vscode from 'vscode';
import { parse } from 'node-html-parser';
import { getStepsHtml, forceRefreshSteps as forceRefreshStepsCore } from './stepsFetcher'; 

// Интерфейс для хранения определений шагов и их описаний
interface StepDefinition {
    pattern: string;      // Оригинальный шаблон с плейсхолдерами
    firstLine: string;    // Только первая строка шаблона
    segments: string[];   // Шаблон, разбитый на сегменты между плейсхолдерами
    description: string;  // Описание шага
    startsWithPlaceholder: boolean; 
}

export class DriveHoverProvider implements vscode.HoverProvider {
    private stepDefinitions: StepDefinition[] = [];
    private isLoading: boolean = false;
    private loadingPromise: Promise<void> | null = null;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        // Загружаем определения асинхронно, не блокируя конструктор
        this.loadStepDefinitions().catch(err => {
            console.error("[DriveHoverProvider] Initial load failed on constructor:", err.message);
        });
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
                vscode.window.showWarningMessage(`Ошибка при обновлении подсказок: ${error.message}. Попытка загрузить из резервных источников.`);
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
                if (cells.length >= 2) {
                    const stepPattern = cells[0].textContent.trim();
                    const stepDescription = cells[1].textContent.trim();
                    if (!stepPattern) return;
                    this.createStepDefinition(stepPattern, stepDescription);
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
            .catch(error => {
                console.error(`[DriveHoverProvider] Ошибка загрузки steps.htm для подсказок: ${error.message}`);
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
            
            const gherkinKeywords = /^(?:And|Then|When|Given|Но|Тогда|Когда|Если|И|К тому же|Допустим)\s+/i;
            const firstLineWithoutKeywords = firstLineOriginal.replace(gherkinKeywords, '');

            const placeholderRegex = /%\d+\s+[a-zA-Z0-9_]+/g;
            
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
            this.stepDefinitions.push({
                pattern: cleanedPattern,
                firstLine: firstLineOriginal, // Сохраняем оригинальную первую строку
                segments,
                description,
                startsWithPlaceholder // Сохраняем флаг
            });
        } catch (error) {
            console.error(`[DriveHoverProvider] Ошибка обработки шаблона "${pattern}": ${error}`);
        }
    }
    
    private matchLineToPattern(line: string, stepDef: StepDefinition): boolean {
        const gherkinKeywords = /^(?:And|Then|When|Given|Но|Тогда|Когда|Если|И|К тому же|Допустим)\s+/i;
        const cleanLine = line.trim().replace(gherkinKeywords, '');
        const cleanFirstLineDef = stepDef.firstLine.trim().replace(gherkinKeywords, ''); // Сравниваем тоже с очищенной от Gherkin ключевых слов

        if (stepDef.segments.length === 1) { // Если в шаблоне нет плейсхолдеров
            return cleanLine === cleanFirstLineDef;
        }
        
        let lineRemainder = cleanLine;
        
        for (let i = 0; i < stepDef.segments.length; i++) {
            const segment = stepDef.segments[i].trim().replace(gherkinKeywords, ''); // Также очищаем сегмент от Gherkin слов

            // Если первый сегмент пустой, это значит, что шаблон начинался с плейсхолдера
            if (i === 0 && segment === "" && stepDef.startsWithPlaceholder) {
                // Если шаблон должен начинаться с плейсхолдера (т.е. первый сегмент пуст),
                // а в проверяемой строке нет ничего перед следующим ожидаемым сегментом,
                // то это может быть совпадением, если плейсхолдер "съел" начало строки.
                // Пропускаем этот пустой сегмент.
                continue;
            }
            
            // Если сегмент не пустой
            if (segment) {
                const segmentIndex = lineRemainder.indexOf(segment);
                
                // Первый непустой сегмент должен быть в начале оставшейся строки,
                // если шаблон не начинался с плейсхолдера.
                // Если шаблон начинался с плейсхолдера, то первый непустой сегмент может быть не в начале.
                if (segmentIndex === -1 || (i === 0 && !stepDef.startsWithPlaceholder && segmentIndex !== 0)) {
                    return false;
                }
                if (segmentIndex === -1) return false; // Сегмент вообще не найден

                // Если это первый значащий сегмент (не пустой из-за начального плейсхолдера)
                // и шаблон не должен был начинаться с плейсхолдера, то сегмент должен быть в самом начале.
                if (i === (stepDef.startsWithPlaceholder ? 1 : 0) && !stepDef.segments[0].trim() && segmentIndex !== 0) {
                    // Это условие для случая, когда первый сегмент шаблона НЕ пустой (т.е. не начинается с плейсхолдера),
                    // тогда он должен быть в самом начале cleanLine.
                    // Если stepDef.startsWithPlaceholder, то первый *значащий* сегмент (stepDef.segments[1]) может быть не в начале.
                } else if (i === 0 && !stepDef.startsWithPlaceholder && segmentIndex !== 0) {
                     return false; // Первый сегмент (если не было начального плейсхолдера) должен быть в начале
                }


                lineRemainder = lineRemainder.substring(segmentIndex + segment.length);
            } else if (i < stepDef.segments.length - 1) {
                // Если сегмент пустой, но это не последний сегмент, значит, здесь был плейсхолдер.
                // Нам нужно убедиться, что следующий сегмент найден, а между ними что-то было (или не было).
                // Эта логика становится сложной, если плейсхолдеры могут быть пустыми.
                // Для простоты, если сегмент пуст, мы просто продолжаем, предполагая, что плейсхолдер "съел" какую-то часть строки.
            }
        }
        
        return true; 
    }

    public async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | null> {
        if (this.isLoading && this.loadingPromise) {
            await this.loadingPromise;
        } else if (this.stepDefinitions.length === 0 && !this.isLoading) {
            await this.loadStepDefinitions();
        }

        if (token.isCancellationRequested || this.stepDefinitions.length === 0) {
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
        
        for (const stepDef of this.stepDefinitions) {
            if (token.isCancellationRequested) return null;
            try {
                if (this.matchLineToPattern(lineText, stepDef)) {
                    const content = new vscode.MarkdownString();
                    content.appendMarkdown(`**Описание шага:**\n\n${stepDef.description}`);
                    
                    // Добавляем оригинальный шаблон для справки
                    content.appendMarkdown(`\n\n---\n\n**Шаблон:**\n\n\`${stepDef.pattern}\``);
                    
                    return new vscode.Hover(content);
                }
            } catch (error) {
                console.error(`[DriveHoverProvider] Ошибка сопоставления строки "${lineText}" с "${stepDef.firstLine}": ${error}`);
            }
        }
        
        return null;
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
}