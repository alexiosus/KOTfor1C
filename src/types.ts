import * as vscode from 'vscode';

/**
 * Информация о найденном тесте/сценарии.
 */
export interface TestInfo {
    /** Имя теста (из поля Имя:) */
    name: string;
    /** * Название вкладки (из `KOTМетаданные.PhaseSwitcher.Tab` или legacy `# PhaseSwitcher_Tab:`). 
     * Опционально, так как не все сценарии будут иметь этот ключ.
     */
    tabName?: string; 
    /** * Состояние по умолчанию (из `KOTМетаданные.PhaseSwitcher.Default` или legacy `# PhaseSwitcher_Default:`). 
     * Опционально.
     */
    defaultState?: boolean;
    /** * Порядок сортировки внутри вкладки (из `KOTМетаданные.PhaseSwitcher.OrderOnTab` или legacy `# PhaseSwitcher_OrderOnTab:`).
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
    /** Код сценария (из блока ДанныеСценария.Код) */
    scenarioCode?: string;
    /** Номер строки поля Код в YAML (0-based) */
    scenarioCodeLine?: number;
    /** Начальная позиция (character) строки поля Код в YAML (0-based) */
    scenarioCodeLineStartCharacter?: number;
    /** Конечная позиция (character) строки поля Код в YAML (0-based) */
    scenarioCodeLineEndCharacter?: number;
}
