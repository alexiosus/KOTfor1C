import * as vscode from 'vscode';

export interface ProcessStepReference {
    uid?: string;
    name?: string;
    type: 'scenario' | 'process';
    scenarioName?: string;
    scenarioUid?: string;
    scenarioCode?: string;
    processName?: string;
    processUid?: string;
}

/**
 * Информация о найденном тесте/сценарии.
 */
export interface TestInfo {
    /** Отсутствующее значение сохраняет совместимость с обычными сценариями. */
    kind?: 'scenario' | 'process';
    /** A compiler settings file in this project references this descriptor UID. */
    hasTestSettings?: boolean;
    /** ПолныйКод процесса, используемый компилятором в ProcessFilter. */
    processCode?: string;
    /** Упорядоченные ссылки на сценарии и вложенные процессы. */
    processSteps?: ProcessStepReference[];
    /** Имя теста (из поля Имя:) */
    name: string;
    /** * Название вкладки (из `KOTМетаданные.PhaseSwitcher.Tab` или legacy `# PhaseSwitcher_Tab:`). 
     * Опционально, так как не все сценарии будут иметь этот ключ.
     */
    tabName?: string; 
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
    parameterTypes?: Record<string, 'scalar' | 'table'>;
    /** Имена вызываемых вложенных сценариев (из блока ВложенныеСценарии) */
    nestedScenarioNames?: string[];
    /** UID сценария (из блока ДанныеСценария) */
    uid?: string;
    /** Код сценария (из блока ДанныеСценария.Код) */
    scenarioCode?: string;
    /** Описание сценария (из блока KOTМетаданные.Описание) */
    scenarioDescription?: string;
    /** Категория вызываемого вложенного сценария (из блока KOTМетаданные.Категория) */
    scenarioCategory?: string;
    /** Saved header values reused by shared catalog discovery without rereading scenario files. */
    catalogValues?: { project?: string; reportLevel1?: string; reportLevel2?: string; responsible?: string; systemFunction?: { name: string; uid: string } };
    /** Номер строки поля Код в YAML (0-based) */
    scenarioCodeLine?: number;
    /** Начальная позиция (character) строки поля Код в YAML (0-based) */
    scenarioCodeLineStartCharacter?: number;
    /** Конечная позиция (character) строки поля Код в YAML (0-based) */
    scenarioCodeLineEndCharacter?: number;
}
