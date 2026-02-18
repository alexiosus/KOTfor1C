import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getExtensionUri } from './appContext';

// Ключ для хранения параметров в SecretStorage
const YAML_PARAMETERS_KEY = 'kotTestToolkit.yamlParameters';

export interface YamlParameter {
    key: string;
    value: string;
}

export interface AdditionalVanessaParameter {
    key: string;
    value: string;
    overrideExisting: boolean;
}

export interface GlobalVanessaVariable {
    key: string;
    value: string;
    overrideExisting: boolean;
}

interface YamlParametersState {
    buildParameters: YamlParameter[];
    additionalVanessaParameters: AdditionalVanessaParameter[];
    globalVanessaVariables: GlobalVanessaVariable[];
}

interface YamlParametersStorageV3 {
    version: 3;
    buildParameters: YamlParameter[];
    additionalVanessaParameters: AdditionalVanessaParameter[];
    globalVanessaVariables: GlobalVanessaVariable[];
}

export class YamlParametersManager {
    private static instance: YamlParametersManager;
    private _extensionUri: vscode.Uri;
    private _context: vscode.ExtensionContext;
    private _langOverride: 'System' | 'English' | 'Русский' = 'System';
    private _ruBundle: Record<string, string> | null = null;

    private constructor(context: vscode.ExtensionContext) {
        this._context = context;
        this._extensionUri = getExtensionUri();
    }

    /**
     * Загружает настройки локализации
     */
    private async loadLocalizationBundleIfNeeded(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('kotTestToolkit.localization');
        const override = (cfg.get<string>('languageOverride') as 'System' | 'English' | 'Русский') || 'System';
        this._langOverride = override;
        if (override === 'Русский') {
            try {
                const ruUri = vscode.Uri.joinPath(this._extensionUri, 'l10n', 'bundle.l10n.ru.json');
                const bytes = await vscode.workspace.fs.readFile(ruUri);
                this._ruBundle = JSON.parse(Buffer.from(bytes).toString('utf-8')) as Record<string, string>;
            } catch (e) {
                console.warn('[YamlParametersManager] Failed to load RU bundle:', e);
                this._ruBundle = null;
            }
        } else {
            this._ruBundle = null;
        }
    }

    /**
     * Форматирует плейсхолдеры в строке
     */
    private formatPlaceholders(template: string, args: string[]): string {
        return template.replace(/\{(\d+)\}/g, (m, idx) => {
            const i = Number(idx);
            return i >= 0 && i < args.length ? args[i] : m;
        });
    }

    /**
     * Метод для перевода строк
     */
    private t(message: string, ...args: string[]): string {
        if (this._langOverride === 'System') {
            return vscode.l10n.t(message, ...args);
        }
        if (this._langOverride === 'Русский') {
            const translated = (this._ruBundle && this._ruBundle[message]) || message;
            return args.length ? this.formatPlaceholders(translated, args) : translated;
        }
        // en override: return default English and format placeholders
        return args.length ? this.formatPlaceholders(message, args) : message;
    }

    public static getInstance(context: vscode.ExtensionContext): YamlParametersManager {
        if (!YamlParametersManager.instance) {
            YamlParametersManager.instance = new YamlParametersManager(context);
        }
        return YamlParametersManager.instance;
    }

    /**
     * Получает параметры по умолчанию из примера
     */
    public getDefaultParameters(): YamlParameter[] {
        // Получаем BuildPath из настроек
        const config = vscode.workspace.getConfiguration('kotTestToolkit');
        const buildPath = config.get<string>('assembleScript.buildPath') || 'C:\\EtalonDrive\\';

        // Получаем путь к корню проекта
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const projectPath = workspaceFolders && workspaceFolders.length > 0
            ? workspaceFolders[0].uri.fsPath + path.sep
            : 'C:\\EtalonDrive\\';

        // Получаем yamlSourcePath из настроек или используем путь по умолчанию
        const yamlSourcePath = config.get<string>('paths.yamlSourceDirectory') || path.join(projectPath, 'tests', 'RegressionTests', 'yaml');

        return [
            { key: 'ScenarioFolder', value: yamlSourcePath },
            { key: 'ExternalMode', value: 'TRUE' },
            { key: 'ModelDBSettings', value: path.join(projectPath, 'tests', 'RegressionTests', 'bases', 'bases.yaml') },
            { key: 'ModelDBid', value: 'EtalonDrive' },
            { key: 'FeatureFolder', value: path.join(buildPath, 'tests') },
            { key: 'LaunchDBFolder', value: 'Srvr="ServerName";Ref="InfobaseName"' },
            { key: 'VanessaFolder', value: 'tools/vanessa' },
            { key: 'jUnitFolder', value: path.join(buildPath, 'junit') },
            { key: 'ScenarioLogFile', value: path.join(buildPath, 'vanessa_progress.log') },
            { key: 'ScenarioOutFile', value: path.join(buildPath, 'vanessa_test_status.log') },
            { key: 'Useaddinforscreencapture', value: 'True' },
            { key: 'ScreenshotsFolder', value: path.join(buildPath, 'screenshots') },
            { key: 'BDDLogFolder', value: path.join(buildPath, 'vanessa_error_logs') },
            { key: 'Libraries', value: 'tools/vanessa/features/Libraries' },
            { key: 'UC', value: 'GodMode' },
            { key: 'SplitFeatureFiles', value: 'False' },
            { key: 'onerrorscreenshoteverywindow', value: 'False' },
            { key: 'runtestclientwithmaximizedwindow', value: 'True' }
        ];
    }

    /**
     * Нормализует список параметров
     */
    private normalizeParameters(raw: unknown): YamlParameter[] {
        if (!Array.isArray(raw)) {
            return [];
        }

        const result: YamlParameter[] = [];
        for (const item of raw) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const key = String((item as { key?: unknown }).key || '').trim();
            const value = String((item as { value?: unknown }).value || '');
            if (!key) {
                continue;
            }
            result.push({ key, value });
        }

        return result;
    }

    /**
     * Нормализует список дополнительных параметров Vanessa
     */
    private normalizeAdditionalVanessaParameters(raw: unknown): AdditionalVanessaParameter[] {
        if (!Array.isArray(raw)) {
            return [];
        }

        const result: AdditionalVanessaParameter[] = [];
        for (const item of raw) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const key = String((item as { key?: unknown }).key || '').trim();
            const value = String((item as { value?: unknown }).value || '');
            if (!key) {
                continue;
            }
            const overrideExisting = Boolean(
                (item as { overrideExisting?: unknown }).overrideExisting
                ?? (item as { priority?: unknown }).priority
            );
            result.push({ key, value, overrideExisting });
        }

        return result;
    }

    /**
     * Нормализует список пользовательских GlobalVars
     */
    private normalizeGlobalVanessaVariables(raw: unknown): GlobalVanessaVariable[] {
        if (!Array.isArray(raw)) {
            return [];
        }

        const result: GlobalVanessaVariable[] = [];
        for (const item of raw) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const key = String((item as { key?: unknown }).key || '').trim();
            const value = String((item as { value?: unknown }).value || '');
            if (!key) {
                continue;
            }
            const overrideExisting = Boolean(
                (item as { overrideExisting?: unknown }).overrideExisting
                ?? (item as { priority?: unknown }).priority
            );
            result.push({ key, value, overrideExisting });
        }

        return result;
    }

    private stringifyAnyJsonValue(value: unknown): string {
        if (value === undefined || value === null) {
            return '';
        }
        if (typeof value === 'string') {
            return value;
        }
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
            return String(value);
        }
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }

    private flattenAdditionalParametersFromJson(
        value: unknown,
        currentPath: string,
        result: AdditionalVanessaParameter[]
    ): void {
        if (Array.isArray(value)) {
            if (value.length === 0) {
                if (currentPath) {
                    result.push({
                        key: currentPath,
                        value: '[]',
                        overrideExisting: false
                    });
                }
                return;
            }

            value.forEach((item, index) => {
                const nextPath = currentPath ? `${currentPath}[${index}]` : `[${index}]`;
                this.flattenAdditionalParametersFromJson(item, nextPath, result);
            });
            return;
        }

        if (value && typeof value === 'object') {
            const entries = Object.entries(value as Record<string, unknown>);
            if (entries.length === 0) {
                if (currentPath) {
                    result.push({
                        key: currentPath,
                        value: '{}',
                        overrideExisting: false
                    });
                }
                return;
            }

            entries.forEach(([rawKey, item]) => {
                const key = rawKey.trim();
                if (!key) {
                    return;
                }
                const nextPath = currentPath ? `${currentPath}.${key}` : key;
                this.flattenAdditionalParametersFromJson(item, nextPath, result);
            });
            return;
        }

        if (!currentPath) {
            return;
        }

        result.push({
            key: currentPath,
            value: this.stringifyAnyJsonValue(value),
            overrideExisting: false
        });
    }

    private parseJsonText(jsonText: string): unknown {
        const normalized = jsonText.replace(/^\uFEFF/, '');
        return JSON.parse(normalized);
    }

    private parseAdditionalParametersFromJsonData(jsonData: unknown): AdditionalVanessaParameter[] | null {
        if (Array.isArray(jsonData)) {
            return this.normalizeAdditionalVanessaParameters(jsonData);
        }

        if (!jsonData || typeof jsonData !== 'object') {
            return null;
        }

        const maybeContainer = jsonData as { additionalVanessaParameters?: unknown };
        if (Array.isArray(maybeContainer.additionalVanessaParameters)) {
            return this.normalizeAdditionalVanessaParameters(maybeContainer.additionalVanessaParameters);
        }

        const additional: AdditionalVanessaParameter[] = [];
        this.flattenAdditionalParametersFromJson(jsonData, '', additional);
        return this.normalizeAdditionalVanessaParameters(additional);
    }

    private parseGlobalVarsFromJsonData(jsonData: unknown): GlobalVanessaVariable[] | null {
        if (Array.isArray(jsonData)) {
            return this.normalizeGlobalVanessaVariables(jsonData);
        }

        if (!jsonData || typeof jsonData !== 'object') {
            return null;
        }

        const asObject = jsonData as Record<string, unknown>;
        const directContainer = Object.keys(asObject).find(
            key => key.trim().toLowerCase() === 'globalvars' || key.trim().toLowerCase() === 'глобальныепеременные'
        );
        if (directContainer) {
            const varsNode = asObject[directContainer];
            if (!varsNode || typeof varsNode !== 'object' || Array.isArray(varsNode)) {
                return [];
            }
            return this.normalizeGlobalVanessaVariables(
                Object.entries(varsNode as Record<string, unknown>).map(([key, value]) => ({
                    key,
                    value: this.stringifyAnyJsonValue(value),
                    overrideExisting: false
                }))
            );
        }

        const maybeContainer = jsonData as { globalVanessaVariables?: unknown };
        if (Array.isArray(maybeContainer.globalVanessaVariables)) {
            return this.normalizeGlobalVanessaVariables(maybeContainer.globalVanessaVariables);
        }

        return this.normalizeGlobalVanessaVariables(
            Object.entries(asObject).map(([key, value]) => ({
                key,
                value: this.stringifyAnyJsonValue(value),
                overrideExisting: false
            }))
        );
    }

    private getDefaultState(): YamlParametersState {
        return {
            buildParameters: this.getDefaultParameters(),
            additionalVanessaParameters: [],
            globalVanessaVariables: []
        };
    }

    private async loadParametersState(): Promise<YamlParametersState> {
        try {
            const saved = await this._context.secrets.get(YAML_PARAMETERS_KEY);
            if (!saved) {
                return this.getDefaultState();
            }

            const parsed = JSON.parse(saved) as unknown;
            // Legacy format: plain array of build parameters.
            if (Array.isArray(parsed)) {
                const legacyBuild = this.normalizeParameters(parsed);
                return {
                    buildParameters: legacyBuild.length > 0 ? legacyBuild : this.getDefaultParameters(),
                    additionalVanessaParameters: [],
                    globalVanessaVariables: []
                };
            }

            if (parsed && typeof parsed === 'object') {
                const payload = parsed as Partial<YamlParametersStorageV3> & { globalVanessaVariables?: unknown };
                const buildParameters = this.normalizeParameters(payload.buildParameters);
                const additionalVanessaParameters = this.normalizeAdditionalVanessaParameters(payload.additionalVanessaParameters);
                const globalVanessaVariables = this.normalizeGlobalVanessaVariables(payload.globalVanessaVariables);
                return {
                    buildParameters: buildParameters.length > 0 ? buildParameters : this.getDefaultParameters(),
                    additionalVanessaParameters,
                    globalVanessaVariables
                };
            }
        } catch (error) {
            console.error('Error loading build scenario parameters:', error);
        }

        return this.getDefaultState();
    }

    private async saveParametersState(state: YamlParametersState): Promise<void> {
        const payload: YamlParametersStorageV3 = {
            version: 3,
            buildParameters: state.buildParameters,
            additionalVanessaParameters: state.additionalVanessaParameters,
            globalVanessaVariables: state.globalVanessaVariables
        };
        await this._context.secrets.store(YAML_PARAMETERS_KEY, JSON.stringify(payload));
    }

    /**
     * Загружает сохраненные build-параметры или возвращает параметры по умолчанию
     */
    public async loadParameters(): Promise<YamlParameter[]> {
        const state = await this.loadParametersState();
        return state.buildParameters;
    }

    /**
     * Загружает дополнительные Vanessa-параметры
     */
    public async loadAdditionalVanessaParameters(): Promise<AdditionalVanessaParameter[]> {
        const state = await this.loadParametersState();
        return state.additionalVanessaParameters;
    }

    /**
     * Загружает пользовательские GlobalVars
     */
    public async loadGlobalVanessaVariables(): Promise<GlobalVanessaVariable[]> {
        const state = await this.loadParametersState();
        return state.globalVanessaVariables;
    }

    /**
     * Сохраняет build-параметры в SecretStorage (совместимость со старым API)
     */
    public async saveParameters(parameters: YamlParameter[]): Promise<void> {
        try {
            const state = await this.loadParametersState();
            await this.saveParametersState({
                buildParameters: this.normalizeParameters(parameters),
                additionalVanessaParameters: state.additionalVanessaParameters,
                globalVanessaVariables: state.globalVanessaVariables
            });
        } catch (error) {
            console.error('Error saving build scenario parameters:', error);
            throw error;
        }
    }

    /**
     * Сохраняет обе секции параметров
     */
    public async saveAllParameters(
        buildParameters: YamlParameter[],
        additionalVanessaParameters: AdditionalVanessaParameter[],
        globalVanessaVariables: GlobalVanessaVariable[]
    ): Promise<void> {
        try {
            await this.saveParametersState({
                buildParameters: this.normalizeParameters(buildParameters),
                additionalVanessaParameters: this.normalizeAdditionalVanessaParameters(additionalVanessaParameters),
                globalVanessaVariables: this.normalizeGlobalVanessaVariables(globalVanessaVariables)
            });
        } catch (error) {
            console.error('Error saving build scenario parameters:', error);
            throw error;
        }
    }

    /**
     * Создает JSON файл для дополнительных параметров Vanessa
     */
    public async createAdditionalVanessaParametersFile(targetPath: string, parameters: AdditionalVanessaParameter[]): Promise<void> {
        const payload: Record<string, string> = {};
        parameters.forEach(param => {
            if (!param.key.trim()) {
                return;
            }
            payload[param.key.trim()] = param.value;
        });

        const targetDir = path.dirname(targetPath);
        await fs.promises.mkdir(targetDir, { recursive: true });
        const jsonContent = JSON.stringify(payload, null, 2);
        await fs.promises.writeFile(targetPath, jsonContent, 'utf8');
    }

    /**
     * Создает JSON файл для пользовательских GlobalVars
     */
    public async createGlobalVanessaVariablesFile(targetPath: string, parameters: GlobalVanessaVariable[]): Promise<void> {
        const payload: Record<string, string> = {};
        parameters.forEach(param => {
            if (!param.key.trim()) {
                return;
            }
            payload[param.key.trim()] = param.value;
        });

        const targetDir = path.dirname(targetPath);
        await fs.promises.mkdir(targetDir, { recursive: true });
        const jsonContent = JSON.stringify(payload, null, 2);
        await fs.promises.writeFile(targetPath, jsonContent, 'utf8');
    }

    /**
     * Создает файл yaml_parameters.json из сохранённых build-параметров
     */
    public async createYamlParametersFile(targetPath: string): Promise<void>;
    public async createYamlParametersFile(targetPath: string, parameters: YamlParameter[]): Promise<void>;
    public async createYamlParametersFile(targetPath: string, parameters?: YamlParameter[]): Promise<void> {
        // Если параметры не переданы, загружаем из storage
        if (!parameters) {
            parameters = await this.loadParameters();
        }
        try {
            // Получаем путь к корню проекта
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error('No workspace folder is open');
            }
            const workspaceRoot = workspaceFolders[0].uri.fsPath;

            // Создаем объект из параметров
            const yamlParams: Record<string, string> = {};
            parameters.forEach(param => {
                let value = param.value;

                // Проверяем, является ли значение путем
                if (this.isPath(param.value)) {
                    // Это путь - обрабатываем соответственно
                    if (this.isAbsolutePath(param.value)) {
                        // Это абсолютный путь, оставляем как есть
                        value = param.value;
                    } else if (param.value.startsWith('./') || param.value.startsWith('../')) {
                        // Это относительный путь от текущей директории, оставляем как есть
                        value = param.value;
                    } else if (param.value.startsWith('~/')) {
                        // Это путь от домашней директории, оставляем как есть
                        value = param.value;
                    } else {
                        // Это относительный путь к корню проекта, преобразуем в абсолютный
                        value = path.resolve(workspaceRoot, param.value);
                    }
                } else {
                    // Это не путь (например, TRUE, FALSE, GodMode), оставляем как есть
                    value = param.value;
                }

                yamlParams[param.key] = value;
            });

            // Создаем директорию если не существует
            const targetDir = path.dirname(targetPath);
            await fs.promises.mkdir(targetDir, { recursive: true });

            // Записываем файл с правильным форматированием путей
            const jsonContent = this.formatYamlParametersJson(yamlParams);
            await fs.promises.writeFile(targetPath, jsonContent, 'utf8');
        } catch (error) {
            console.error('Error creating build scenario parameters file:', error);
            throw error;
        }
    }

    /**
     * Форматирует JSON для yaml_parameters.json с правильными слешами
     */
    private formatYamlParametersJson(yamlParams: Record<string, string>): string {
        // Используем стандартный JSON.stringify, но заменяем двойные слеши на одинарные
        let jsonContent = JSON.stringify(yamlParams, null, 2);

        // Заменяем двойные обратные слеши на прямые слеши (только в путях, не в кавычках)
        jsonContent = jsonContent.replace(/\\\\/g, '/');

        return jsonContent;
    }

    /**
     * Проверяет, является ли строка путем к файлу/папке
     */
    private isPath(value: string): boolean {
        // Пустая строка или очень короткая строка - не путь
        if (!value || value.length < 2) {
            return false;
        }

        // Содержит расширение файла - скорее всего путь
        if (/\.[a-zA-Z0-9]{1,10}$/.test(value)) {
            return true;
        }

        // Содержит слэши или обратные слэши - скорее всего путь
        if (value.includes('/') || value.includes('\\')) {
            return true;
        }

        // Начинается с ~ (домашняя директория) - путь
        if (value.startsWith('~')) {
            return true;
        }

        // Простые строки без слэшей и расширений - не пути
        // Например: TRUE, FALSE, GodMode, EtalonDrive
        if (/^[a-zA-Z0-9_-]+$/.test(value)) {
            return false;
        }

        // Строки с параметрами (содержат = и ;) - не пути
        // Например: Srvr="#ServerName";Ref="#InfobaseName"
        if (value.includes('=') && value.includes(';')) {
            return false;
        }

        // Строки с кавычками и параметрами - не пути
        // Например: "Srvr=\"#ServerName\";Ref=\"#InfobaseName\""
        if (value.includes('"') && (value.includes('=') || value.includes(';'))) {
            return false;
        }

        // Содержит двоеточие (но не в начале) - скорее всего путь
        if (value.includes(':') && !value.startsWith(':')) {
            return true;
        }

        // Содержит # (но не в кавычках и не как часть параметра) - может быть путь
        if (value.includes('#')) {
            // Если это просто # без других признаков пути - не путь
            if (value === '#' || value.startsWith('#') && !value.includes('/') && !value.includes('\\')) {
                return false;
            }
            // Если содержит # и слэши - путь
            if (value.includes('/') || value.includes('\\')) {
                return true;
            }
            // По умолчанию для строк с # считаем, что это не путь
            return false;
        }

        // По умолчанию считаем, что это не путь
        return false;
    }

    /**
     * Проверяет, является ли путь абсолютным или относительным
     */
    public isAbsolutePath(pathStr: string): boolean {
        // Используем стандартную функцию Node.js для определения абсолютного пути
        return path.isAbsolute(pathStr);
    }

    /**
     * Преобразует относительный путь в абсолютный относительно корня проекта
     */
    public resolvePath(relativePath: string, workspaceRoot: string): string {
        if (this.isAbsolutePath(relativePath)) {
            return relativePath;
        }
        if (relativePath.startsWith('./') || relativePath.startsWith('../')) {
            // Это относительный путь от текущей директории, оставляем как есть
            return relativePath;
        }
        if (relativePath.startsWith('~/')) {
            // Это путь от домашней директории, оставляем как есть
            return relativePath;
        }
        // Это относительный путь к корню проекта, преобразуем в абсолютный
        return path.resolve(workspaceRoot, relativePath);
    }

    /**
     * Открывает панель управления YAML параметрами
     */
    public async openYamlParametersPanel(): Promise<void> {
        await this.loadLocalizationBundleIfNeeded();

        const panel = vscode.window.createWebviewPanel(
            'yamlParametersPanel',
            'Build Scenario Parameters Manager',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this._extensionUri, 'media')
                ]
            }
        );

        const state = await this.loadParametersState();
        const html = await this.getWebviewContent(
            panel.webview,
            state.buildParameters,
            state.additionalVanessaParameters,
            state.globalVanessaVariables
        );
        panel.webview.html = html;

        // Обработка сообщений от webview
        panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'saveParameters':
                        try {
                            const buildParameters = this.normalizeParameters(message.buildParameters ?? message.parameters);
                            const additionalVanessaParameters = this.normalizeAdditionalVanessaParameters(message.additionalVanessaParameters);
                            const globalVanessaVariables = this.normalizeGlobalVanessaVariables(message.globalVanessaVariables);
                            await this.saveAllParameters(buildParameters, additionalVanessaParameters, globalVanessaVariables);
                            vscode.window.showInformationMessage(this.t('Build scenario parameters saved successfully'));
                        } catch (error) {
                            vscode.window.showErrorMessage(this.t('Error saving parameters: {0}', String(error)));
                        }
                        break;
                    case 'createYamlFile':
                        try {
                            const workspaceFolders = vscode.workspace.workspaceFolders;
                            if (!workspaceFolders || workspaceFolders.length === 0) {
                                vscode.window.showErrorMessage(this.t('No workspace folder is open'));
                                return;
                            }

                            // Предлагаем выбрать место для сохранения
                            const uri = await vscode.window.showSaveDialog({
                                title: this.t('Save Build Scenario Parameters File'),
                                filters: {
                                    [this.t('JSON Files')]: ['json']
                                },
                                defaultUri: vscode.Uri.file('yaml_parameters.json')
                            });

                            if (uri) {
                                const buildParameters = this.normalizeParameters(message.buildParameters ?? message.parameters);
                                await this.createYamlParametersFile(uri.fsPath, buildParameters);

                                // Показываем уведомление с кнопками
                                const action = await vscode.window.showInformationMessage(
                                    this.t('Build scenario parameters file created at: {0}', uri.fsPath),
                                    this.t('Open File'),
                                    this.t('Open Folder')
                                );

                                if (action === this.t('Open File')) {
                                    const doc = await vscode.workspace.openTextDocument(uri);
                                    await vscode.window.showTextDocument(doc);
                                } else if (action === this.t('Open Folder')) {
                                    // Открываем папку с выделенным файлом
                                    vscode.commands.executeCommand('revealFileInOS', uri);
                                }
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(this.t('Error creating JSON file: {0}', String(error)));
                        }
                        break;
                    case 'loadBuildFromJson':
                        try {
                            const uris = await vscode.window.showOpenDialog({
                                title: this.t('Load Build Scenario Parameters from JSON'),
                                filters: {
                                    [this.t('JSON Files')]: ['json']
                                },
                                canSelectMany: false
                            });

                            if (uris && uris.length > 0) {
                                const filePath = uris[0].fsPath;
                                const fileContent = await fs.promises.readFile(filePath, 'utf8');
                                const jsonData = this.parseJsonText(fileContent);

                                // Проверяем, что это объект с ключ-значение
                                if (typeof jsonData === 'object' && jsonData !== null && !Array.isArray(jsonData)) {
                                    const buildParameters: YamlParameter[] = Object.entries(jsonData).map(([key, value]) => ({
                                        key: String(key),
                                        value: String(value)
                                    }));

                                    // Отправляем новые параметры в webview
                                    panel.webview.postMessage({
                                        command: 'loadBuildParameters',
                                        buildParameters
                                    });

                                    vscode.window.showInformationMessage(this.t('Loaded {0} parameters from {1}', buildParameters.length.toString(), path.basename(filePath)));
                                } else {
                                    vscode.window.showErrorMessage(this.t('Invalid JSON format. Expected key-value object.'));
                                }
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(this.t('Error loading JSON file: {0}', String(error)));
                        }
                        break;
                    case 'createAdditionalJsonFile':
                        try {
                            const uri = await vscode.window.showSaveDialog({
                                title: this.t('Save Additional Vanessa Parameters File'),
                                filters: {
                                    [this.t('JSON Files')]: ['json']
                                },
                                defaultUri: vscode.Uri.file('vanessa_additional_parameters.json')
                            });

                            if (uri) {
                                const additionalParameters = this.normalizeAdditionalVanessaParameters(message.additionalVanessaParameters);
                                await this.createAdditionalVanessaParametersFile(uri.fsPath, additionalParameters);

                                const action = await vscode.window.showInformationMessage(
                                    this.t('Additional Vanessa parameters file created at: {0}', uri.fsPath),
                                    this.t('Open File'),
                                    this.t('Open Folder')
                                );

                                if (action === this.t('Open File')) {
                                    const doc = await vscode.workspace.openTextDocument(uri);
                                    await vscode.window.showTextDocument(doc);
                                } else if (action === this.t('Open Folder')) {
                                    vscode.commands.executeCommand('revealFileInOS', uri);
                                }
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(this.t('Error creating JSON file: {0}', String(error)));
                        }
                        break;
                    case 'loadAdditionalFromJson':
                        try {
                            const uris = await vscode.window.showOpenDialog({
                                title: this.t('Load Additional Vanessa Parameters from JSON'),
                                filters: {
                                    [this.t('JSON Files')]: ['json']
                                },
                                canSelectMany: false
                            });

                            if (uris && uris.length > 0) {
                                const filePath = uris[0].fsPath;
                                const fileContent = await fs.promises.readFile(filePath, 'utf8');
                                const jsonData = this.parseJsonText(fileContent);
                                const additionalParameters = this.parseAdditionalParametersFromJsonData(jsonData);
                                if (!additionalParameters) {
                                    vscode.window.showErrorMessage(this.t('Invalid JSON format. Expected key-value object.'));
                                    return;
                                }

                                panel.webview.postMessage({
                                    command: 'loadAdditionalParameters',
                                    additionalParameters
                                });

                                vscode.window.showInformationMessage(
                                    this.t('Loaded {0} parameters from {1}', additionalParameters.length.toString(), path.basename(filePath))
                                );
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(this.t('Error loading JSON file: {0}', String(error)));
                        }
                        break;
                    case 'createGlobalVarsJsonFile':
                        try {
                            const uri = await vscode.window.showSaveDialog({
                                title: this.t('Save Global Variables File'),
                                filters: {
                                    [this.t('JSON Files')]: ['json']
                                },
                                defaultUri: vscode.Uri.file('vanessa_global_vars.json')
                            });

                            if (uri) {
                                const globalVariables = this.normalizeGlobalVanessaVariables(message.globalVanessaVariables);
                                await this.createGlobalVanessaVariablesFile(uri.fsPath, globalVariables);

                                const action = await vscode.window.showInformationMessage(
                                    this.t('Global variables file created at: {0}', uri.fsPath),
                                    this.t('Open File'),
                                    this.t('Open Folder')
                                );

                                if (action === this.t('Open File')) {
                                    const doc = await vscode.workspace.openTextDocument(uri);
                                    await vscode.window.showTextDocument(doc);
                                } else if (action === this.t('Open Folder')) {
                                    vscode.commands.executeCommand('revealFileInOS', uri);
                                }
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(this.t('Error creating JSON file: {0}', String(error)));
                        }
                        break;
                    case 'loadGlobalVarsFromJson':
                        try {
                            const uris = await vscode.window.showOpenDialog({
                                title: this.t('Load Global Variables from JSON'),
                                filters: {
                                    [this.t('JSON Files')]: ['json']
                                },
                                canSelectMany: false
                            });

                            if (uris && uris.length > 0) {
                                const filePath = uris[0].fsPath;
                                const fileContent = await fs.promises.readFile(filePath, 'utf8');
                                const jsonData = this.parseJsonText(fileContent);
                                const globalVariables = this.parseGlobalVarsFromJsonData(jsonData);
                                if (!globalVariables) {
                                    vscode.window.showErrorMessage(this.t('Invalid JSON format. Expected key-value object.'));
                                    return;
                                }

                                panel.webview.postMessage({
                                    command: 'loadGlobalVanessaVariables',
                                    globalVanessaVariables: globalVariables
                                });

                                vscode.window.showInformationMessage(
                                    this.t('Loaded {0} parameters from {1}', globalVariables.length.toString(), path.basename(filePath))
                                );
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(this.t('Error loading JSON file: {0}', String(error)));
                        }
                        break;
                }
            }
        );
    }

    /**
     * Генерирует HTML содержимое для webview из шаблона
     */
    private async getWebviewContent(
        webview: vscode.Webview,
        buildParameters: YamlParameter[],
        additionalVanessaParameters: AdditionalVanessaParameter[],
        globalVanessaVariables: GlobalVanessaVariable[]
    ): Promise<string> {
        try {
            // URIs для ресурсов
            const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'codicon.css'));
            const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'yamlParameters.css'));
            const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'yamlParameters.js'));

            // Nonce для CSP
            const nonce = this.getNonce();

            // Определяем язык интерфейса
            const langOverride = this._langOverride;
            const effectiveLang = langOverride === 'System' ? (vscode.env.language || 'English') : langOverride;
            const localeHtmlLang = effectiveLang.split('-')[0];

            // Создаем объект переводов
            const loc = {
                title: this.t('Build Scenario Parameters Manager'),
                description: this.t('Manage build scenario parameters for test configuration'),
                buildSectionTitle: this.t('SPPR build parameters'),
                buildSectionDescription: this.t('Parameters saved into yaml_parameters.json for СборкаТекстовСценариев processing.'),
                additionalSectionTitle: this.t('Additional Vanessa Automation parameters'),
                additionalSectionDescription: this.t('Use this section for VAParams keys not supported by SPPR processing (for example, gherkinlanguage).'),
                globalVarsSectionTitle: this.t('Global variables'),
                globalVarsSectionDescription: this.t('Scenario-level custom GlobalVars merged into VAParams JSON.'),
                pathHint: this.t('You can use relative paths from project root or full paths.'),
                sectionsHint: this.t('• SPPR tab: parameters for СборкаТекстовСценариев. Processing uses them to build yaml_parameters.json and Vanessa settings JSON, but not all VAParams keys are supported.\n• Additional tab: use for unsupported VAParams keys. You can import your own Vanessa settings JSON here.\n• Global variables tab: user GlobalVars that are merged into VAParams at launch time.\n• VAParams: runtime JSON settings for Vanessa Automation scenario launch.\n• Priority: if the same key exists in SPPR and Additional tabs, SPPR value wins by default. To override it, enable \"Override existing value\" in Additional tab.'),
                addBuildParameter: this.t('Add build parameter'),
                addAdditionalParameter: this.t('Add additional parameter'),
                addGlobalVariable: this.t('Add global variable'),
                resetDefaults: this.t('Reset build defaults'),
                clearAdditionalParameters: this.t('Clear additional parameters'),
                clearGlobalVariables: this.t('Clear global variables'),
                parameter: this.t('Parameter'),
                value: this.t('Value'),
                priority: this.t('Priority'),
                overrideExistingValue: this.t('Override existing value'),
                actions: this.t('Actions'),
                save: this.t('Apply'),
                createFile: this.t('Save file'),
                saveAdditionalFile: this.t('Save additional file'),
                loadFromJson: this.t('Load from JSON'),
                loadAdditionalFromJson: this.t('Import VAParams/JSON'),
                saveGlobalVarsFile: this.t('Save global variables file'),
                loadGlobalVarsFromJson: this.t('Import GlobalVars/JSON'),
                moreActions: this.t('More actions'),
                help: this.t('Help'),
                moreInfoOnITS: this.t('More information about SPPR СборкаТекстовСценариев parameters on ITS'),
                moreInfoOnVanessa: this.t('More information about Vanessa Automation JSON parameters'),
                parameterNamePlaceholder: this.t('Parameter name'),
                parameterValuePlaceholder: this.t('Parameter value'),
                removeParameter: this.t('Remove parameter'),
                buildMoreActionsLabel: this.t('Build actions'),
                additionalMoreActionsLabel: this.t('Additional actions'),
                globalVarsMoreActionsLabel: this.t('GlobalVars actions'),
                searchByParameterName: this.t('Search by parameter name'),
                clearSearch: this.t('Clear search')
            };

            // Загружаем HTML шаблон
            const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'yamlParameters.html');
            let htmlContent = Buffer.from(await vscode.workspace.fs.readFile(htmlPath)).toString('utf-8');

            const buildParametersRows = this.renderParametersRows(buildParameters, loc.parameterNamePlaceholder, loc.parameterValuePlaceholder, loc.removeParameter);
            const additionalParametersRows = this.renderAdditionalParametersRows(
                additionalVanessaParameters,
                loc.parameterNamePlaceholder,
                loc.parameterValuePlaceholder,
                loc.removeParameter,
                loc.overrideExistingValue
            );
            const globalVariablesRows = this.renderAdditionalParametersRows(
                globalVanessaVariables,
                loc.parameterNamePlaceholder,
                loc.parameterValuePlaceholder,
                loc.removeParameter,
                loc.overrideExistingValue
            );

            // Заменяем технические плейсхолдеры как в PhaseSwitcher
            htmlContent = htmlContent.replace(/\$\{nonce\}/g, nonce);
            htmlContent = htmlContent.replace('${stylesUri}', stylesUri.toString());
            htmlContent = htmlContent.replace('${scriptUri}', scriptUri.toString());
            htmlContent = htmlContent.replace('${codiconsUri}', codiconsUri.toString());
            htmlContent = htmlContent.replace(/\$\{webview.cspSource\}/g, webview.cspSource);
            htmlContent = htmlContent.replace('${buildParametersRows}', buildParametersRows);
            htmlContent = htmlContent.replace('${additionalParametersRows}', additionalParametersRows);
            htmlContent = htmlContent.replace('${globalVariablesRows}', globalVariablesRows);
            htmlContent = htmlContent.replace('${buildParametersJson}', JSON.stringify(buildParameters));
            htmlContent = htmlContent.replace('${additionalParametersJson}', JSON.stringify(additionalVanessaParameters));
            htmlContent = htmlContent.replace('${globalVanessaVariablesJson}', JSON.stringify(globalVanessaVariables));
            htmlContent = htmlContent.replace('${defaultBuildParametersJson}', JSON.stringify(this.getDefaultParameters()));

            // Заменяем переводы
            htmlContent = htmlContent.replace('${localeHtmlLang}', localeHtmlLang);
            for (const [k, v] of Object.entries(loc)) {
                htmlContent = htmlContent.replace(new RegExp(`\\$\\{loc\\.${k}\\}`, 'g'), v);
            }

            return htmlContent;
        } catch (error) {
            console.error('[YamlParametersManager] Error loading HTML template:', error);
            return `<body><h1>Error loading Build Scenario Parameters Manager</h1><p>${error}</p></body>`;
        }
    }

    private renderParametersRows(parameters: YamlParameter[], keyPlaceholder: string, valuePlaceholder: string, removeTitle: string): string {
        return parameters.map((param, index) => `
                <tr data-index="${index}">
                    <td>
                        <input type="text" class="param-key" value="${this.escapeHtml(param.key)}" placeholder="${this.escapeHtml(keyPlaceholder)}">
                    </td>
                    <td>
                        <input type="text" class="param-value" value="${this.escapeHtml(param.value)}" placeholder="${this.escapeHtml(valuePlaceholder)}">
                    </td>
                    <td>
                        <button class="button-with-icon remove-row-btn" title="${this.escapeHtml(removeTitle)}">
                            <span class="codicon codicon-trash"></span>
                        </button>
                    </td>
                </tr>
            `).join('');
    }

    private renderAdditionalParametersRows(
        parameters: AdditionalVanessaParameter[],
        keyPlaceholder: string,
        valuePlaceholder: string,
        removeTitle: string,
        overrideTitle: string
    ): string {
        return parameters.map((param, index) => `
                <tr data-index="${index}">
                    <td>
                        <input type="text" class="param-key" value="${this.escapeHtml(param.key)}" placeholder="${this.escapeHtml(keyPlaceholder)}">
                    </td>
                    <td>
                        <input type="text" class="param-value" value="${this.escapeHtml(param.value)}" placeholder="${this.escapeHtml(valuePlaceholder)}">
                    </td>
                    <td class="param-priority-cell">
                        <input type="checkbox" class="param-override" ${param.overrideExisting ? 'checked' : ''} title="${this.escapeHtml(overrideTitle)}">
                    </td>
                    <td>
                        <button class="button-with-icon remove-row-btn" title="${this.escapeHtml(removeTitle)}">
                            <span class="codicon codicon-trash"></span>
                        </button>
                    </td>
                </tr>
            `).join('');
    }

    /**
     * Генерирует nonce для CSP
     */
    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    /**
     * Экранирует HTML символы
     */
    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}
