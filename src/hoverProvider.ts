import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parse } from 'node-html-parser';

// Интерфейс для хранения определений шагов и их описаний
interface StepDefinition {
    pattern: string;      // Оригинальный шаблон с плейсхолдерами
    firstLine: string;    // Только первая строка шаблона
    segments: string[];   // Шаблон, разбитый на сегменты между плейсхолдерами
    description: string;  // Описание шага
}

export class DriveHoverProvider implements vscode.HoverProvider {
    private stepDefinitions: StepDefinition[] = [];
    private isLoading: boolean = false;
    private loadingPromise: Promise<void> | null = null;
    
    constructor(private context: vscode.ExtensionContext) {
        // Запускаем загрузку немедленно
        this.loadStepDefinitions();
    }

    private loadStepDefinitions(): Promise<void> {
        // Если уже загружается, возвращаем существующий промис
        if (this.isLoading && this.loadingPromise) {
            return this.loadingPromise;
        }
        
        // Если определения уже загружены, возвращаем разрешенный промис
        if (this.stepDefinitions.length > 0) {
            return Promise.resolve();
        }
        
        this.isLoading = true;
        
        this.loadingPromise = new Promise<void>((resolve, reject) => {
            try {
                const tableFilePath = path.join(this.context.extensionPath, 'res', 'steps.htm');
                
                // Проверяем, существует ли файл
                if (!fs.existsSync(tableFilePath)) {
                    console.error(`[DriveHoverProvider] Файл таблицы не найден: ${tableFilePath}`);
                    this.isLoading = false;
                    reject(new Error('Файл таблицы не найден'));
                    return;
                }
                
                const htmlContent = fs.readFileSync(tableFilePath, 'utf8');
                const root = parse(htmlContent);
                
                // Извлекаем строки из таблицы (все типы строк)
                const rows = root.querySelectorAll('tr');
                
                rows.forEach(row => {
                    // Пропускаем строки, у которых нет нужных классов
                    const rowClass = row.classNames;
                    if (!rowClass || !rowClass.startsWith('R')) {
                        return;
                    }
                    
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 2) {
                        const stepPattern = cells[0].textContent.trim();
                        const stepDescription = cells[1].textContent.trim();
                        
                        // Пропускаем пустые шаги
                        if (!stepPattern) return;
                        
                        // Создаем определение шага с сегментами
                        this.createStepDefinition(stepPattern, stepDescription);
                    }
                });
                
                console.log(`[DriveHoverProvider] Загружено ${this.stepDefinitions.length} определений шагов`);
                this.isLoading = false;
                resolve();
            } catch (error) {
                console.error(`[DriveHoverProvider] Ошибка загрузки определений шагов: ${error}`);
                this.isLoading = false;
                reject(error);
            }
        });
        
        return this.loadingPromise;
    }

    private createStepDefinition(pattern: string, description: string) {
        try {
            // Получаем только первую строку шаблона
            const lines = pattern.split(/\r?\n/);
            const firstLine = lines[0].trim();
            
            // Очищаем шаблон - нормализуем пробелы и переносы строк для полного шаблона
            let cleanedPattern = pattern.replace(/\r?\n\s*/g, ' ').trim();
            
            // Подготавливаем сегменты для первой строки
            // Находим плейсхолдеры типа %1 TableName
            const placeholderRegex = /%\d+\s+[a-zA-Z0-9_]+/g;
            
            // Заменяем каждый плейсхолдер уникальным маркером
            const markerPrefix = '__PLACEHOLDER_';
            let tempPattern = firstLine;
            let placeholderCount = 0;
            
            // Заменяем плейсхолдеры маркерами
            tempPattern = tempPattern.replace(placeholderRegex, () => {
                placeholderCount++;
                return `${markerPrefix}${placeholderCount}__`;
            });
            
            // Разбиваем шаблон по маркерам
            const segments = tempPattern.split(new RegExp(`${markerPrefix}\\d+__`));
            
            // Сохраняем сегменты шаблона для сопоставления
            this.stepDefinitions.push({
                pattern: cleanedPattern, // Сохраняем очищенный шаблон
                firstLine: firstLine,    // Храним первую строку
                segments,
                description
            });
            
            // Логируем для отладки
            console.log(`[DriveHoverProvider] Шаблон: "${firstLine}" -> Сегменты: ${JSON.stringify(segments)}`);
        } catch (error) {
            console.error(`[DriveHoverProvider] Ошибка обработки шаблона "${pattern}": ${error}`);
        }
    }
    
    private matchLineToPattern(line: string, stepDef: StepDefinition): boolean {
        // Простой случай: если нет плейсхолдеров, просто делаем прямое сравнение
        if (stepDef.segments.length === 1) {
            return line.trim() === stepDef.firstLine.trim();
        }
        
        // Более сложный случай с плейсхолдерами
        let lineRemainder = line.trim();
        
        // Пытаемся сопоставить каждый сегмент по порядку
        for (let i = 0; i < stepDef.segments.length; i++) {
            const segment = stepDef.segments[i].trim();
            
            // Пропускаем пустые сегменты
            if (!segment) continue;
            
            // Находим этот сегмент в строке
            const segmentIndex = lineRemainder.indexOf(segment);
            if (segmentIndex === -1) {
                // Сегмент не найден в строке
                return false;
            }
            
            // Двигаемся дальше этого сегмента в строке
            lineRemainder = lineRemainder.substring(segmentIndex + segment.length);
        }
        
        // Если мы сопоставили все сегменты и consumed большую часть строки, это совпадение
        return lineRemainder.trim().length < line.length * 0.4; // Допускаем некоторый текст после последнего сегмента
    }

    public async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | null> {
        // Убеждаемся, что определения шагов загружены
        try {
            await this.loadStepDefinitions();
        } catch (error) {
            console.error(`[DriveHoverProvider] Не удалось загрузить определения шагов: ${error}`);
            return null;
        }
        
        // Выходим, если определения не загружены
        if (this.stepDefinitions.length === 0) {
            return null;
        }
        
        // Показываем подсказки только в блоках текста сценария
        if (!this.isInScenarioTextBlock(document, position)) {
            return null;
        }
        
        // Получаем текст строки
        const lineText = document.lineAt(position.line).text.trim();
        if (!lineText) {
            return null;
        }
        
        // Пропускаем комментарии и другие нестандартные строки
        if (lineText.startsWith('#') || lineText.startsWith('|') || lineText.startsWith('"""')) {
            return null;
        }
        
        // Ищем совпадающее определение шага
        for (const stepDef of this.stepDefinitions) {
            try {
                if (this.matchLineToPattern(lineText, stepDef)) {
                    console.log(`[DriveHoverProvider] Найдено совпадение для строки: "${lineText}" с шаблоном: "${stepDef.firstLine}"`);
                    
                    const content = new vscode.MarkdownString();
                    content.appendMarkdown(`**Описание шага:**\n\n${stepDef.description}`);
                    
                    // Добавляем оригинальный шаблон для справки
                    content.appendMarkdown(`\n\n---\n\n**Шаблон:**\n\n\`${stepDef.pattern}\``);
                    
                    return new vscode.Hover(content);
                }
            } catch (error) {
                console.error(`[DriveHoverProvider] Ошибка сопоставления строки "${lineText}": ${error}`);
            }
        }
        
        return null;
    }
    
    private isInScenarioTextBlock(document: vscode.TextDocument, position: vscode.Position): boolean {
        // Для YAML-файлов, просто проверяем, это yaml-файл с расширением .yaml
        if (document.fileName.toLowerCase().endsWith('.yaml')) {
            const text = document.getText();
            return text.includes('ТекстСценария:');
        }
        return false;
    }
}