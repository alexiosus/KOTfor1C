import * as vscode from 'vscode';

/**
 * Информация о найденном тесте/сценарии.
 */
export interface TestInfo {
    /** Имя теста (из поля Имя:) */
    name: string;
    /** * Название вкладки (из маркера # PhaseSwitcher_Tab:). 
     * Опционально, так как не все сценарии будут иметь этот маркер.
     */
    tabName?: string; 
    /** * Состояние по умолчанию (из маркера # PhaseSwitcher_Default:). 
     * Опционально.
     */
    defaultState?: boolean;
    /** * Порядок сортировки внутри вкладки (из маркера # PhaseSwitcher_OrderOnTab:).
     * Опционально.
     */
    order?: number;
    /** URI самого yaml файла */
    yamlFileUri: vscode.Uri;
    /** Относительный путь к ПАПКЕ теста от базовой папки сканирования */
    relativePath: string;
    /** Параметры сценария (извлекаются из блока ПараметрыСценария) */
    parameters?: string[];
    /** Значения по умолчанию параметров сценария (из блока ПараметрыСценария) */
    parameterDefaults?: Record<string, string>;
    /** Имена вызываемых вложенных сценариев (из блока ВложенныеСценарии) */
    nestedScenarioNames?: string[];
    /** UID сценария (из блока ДанныеСценария) */
    uid?: string;
}
