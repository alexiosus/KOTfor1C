import * as vscode from 'vscode';

/**
 * Информация о найденном тесте/сценарии.
 */
export interface TestInfo {
    /** Имя теста (из поля Имя:) */
    name: string;
    /** Название вкладки (из маркера # PhaseSwitcher_Tab:) */
    tabName: string;
    /** Состояние по умолчанию (из маркера # PhaseSwitcher_Default:) */
    defaultState: boolean;
    /** Порядок сортировки внутри вкладки (из маркера # PhaseSwitcher_OrderOnTab:) */
    order: number;
    /** URI самого yaml файла */
    yamlFileUri: vscode.Uri;
    /** Относительный путь к ПАПКЕ теста от базовой папки сканирования */
    relativePath: string;
}