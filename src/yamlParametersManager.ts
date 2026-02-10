import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getTranslator } from './localization';
import { getExtensionUri } from './appContext';

// Ключ для хранения параметров в SecretStorage
const YAML_PARAMETERS_KEY = 'kotTestToolkit.yamlParameters';

export interface YamlParameter {
    key: string;
    value: string;
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
            { key: "ScenarioFolder", value: yamlSourcePath },
            { key: "ExternalMode", value: "TRUE" },
            { key: "ModelDBSettings", value: path.join(projectPath, 'tests', 'RegressionTests', 'bases', 'bases.yaml') },
            { key: "ModelDBid", value: "EtalonDrive" },
            { key: "FeatureFolder", value: path.join(buildPath, 'tests') },
            { key: "LaunchDBFolder", value: "Srvr=\"ServerName\";Ref=\"InfobaseName\"" },
            { key: "VanessaFolder", value: "tools/vanessa" },
            { key: "jUnitFolder", value: path.join(buildPath, 'junit') },
            { key: "ScenarioLogFile", value: path.join(buildPath, 'vanessa_progress.log') },
            { key: "ScenarioOutFile", value: path.join(buildPath, 'vanessa_test_status.log') },
            { key: "Useaddinforscreencapture", value: "True" },
            { key: "ScreenshotsFolder", value: path.join(buildPath, 'screenshots') },
            { key: "BDDLogFolder", value: path.join(buildPath, 'vanessa_error_logs') },
            { key: "Libraries", value: "tools/vanessa/features/Libraries" },
            { key: "UC", value: "GodMode" },
            { key: "SplitFeatureFiles", value: "False" },
            { key: "onerrorscreenshoteverywindow", value: "False" },
            { key: "runtestclientwithmaximizedwindow", value: "True" }
        ];
    }

    /**
     * Загружает сохраненные параметры или возвращает параметры по умолчанию
     */
    public async loadParameters(): Promise<YamlParameter[]> {
        try {
            const savedParams = await this._context.secrets.get(YAML_PARAMETERS_KEY);
            if (savedParams) {
                return JSON.parse(savedParams);
            }
        } catch (error) {
            console.error('Error loading build scenario parameters:', error);
        }
        return this.getDefaultParameters();
    }

    /**
     * Сохраняет параметры в SecretStorage
     */
    public async saveParameters(parameters: YamlParameter[]): Promise<void> {
        try {
            await this._context.secrets.store(YAML_PARAMETERS_KEY, JSON.stringify(parameters));
        } catch (error) {
            console.error('Error saving build scenario parameters:', error);
            throw error;
        }
    }

    /**
     * Создает файл yaml_parameters.json из сохранённых параметров
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

        const parameters = await this.loadParameters();
        const html = await this.getWebviewContent(panel.webview, parameters);
        panel.webview.html = html;

        // Обработка сообщений от webview
        panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'saveParameters':
                        try {
                            await this.saveParameters(message.parameters);
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
                                title: 'Save Build Scenario Parameters File',
                                filters: {
                                    'JSON Files': ['json']
                                },
                                defaultUri: vscode.Uri.file('yaml_parameters.json')
                            });

                            if (uri) {
                                await this.createYamlParametersFile(uri.fsPath, message.parameters);
                                
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
                    case 'loadFromJson':
                        try {
                            const uris = await vscode.window.showOpenDialog({
                                title: this.t('Load Build Scenario Parameters from JSON'),
                                filters: {
                                    'JSON Files': ['json']
                                },
                                canSelectMany: false
                            });

                            if (uris && uris.length > 0) {
                                const filePath = uris[0].fsPath;
                                const fileContent = await fs.promises.readFile(filePath, 'utf8');
                                const jsonData = JSON.parse(fileContent);

                                // Проверяем, что это объект с ключ-значение
                                if (typeof jsonData === 'object' && jsonData !== null && !Array.isArray(jsonData)) {
                                    const parameters: YamlParameter[] = Object.entries(jsonData).map(([key, value]) => ({
                                        key: String(key),
                                        value: String(value)
                                    }));

                                    // Отправляем новые параметры в webview
                                    panel.webview.postMessage({
                                        command: 'loadParameters',
                                        parameters: parameters
                                    });

                                    vscode.window.showInformationMessage(this.t('Loaded {0} parameters from {1}', parameters.length.toString(), path.basename(filePath)));
                                } else {
                                    vscode.window.showErrorMessage(this.t('Invalid JSON format. Expected key-value object.'));
                                }
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
    private async getWebviewContent(webview: vscode.Webview, parameters: YamlParameter[]): Promise<string> {
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
                pathHint: this.t('You can use relative paths from project root or full paths.'),
                addParameter: this.t('Add Parameter'),
                resetDefaults: this.t('Reset to Defaults'),
                parameter: this.t('Parameter'),
                value: this.t('Value'),
                actions: this.t('Actions'),
                save: this.t('Apply'),
                createFile: this.t('Save file'),
                loadFromJson: this.t('Load from JSON'),
                moreActions: this.t('More actions'),
                help: this.t('Help'),
                moreInfoOnITS: this.t('More information about parameters on ITS')
            };

            // Загружаем HTML шаблон
            const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'yamlParameters.html');
            let htmlContent = Buffer.from(await vscode.workspace.fs.readFile(htmlPath)).toString('utf-8');

            // Генерируем строки таблицы
            const parametersRows = parameters.map((param, index) => `
                <tr data-index="${index}">
                    <td>
                        <input type="text" class="param-key" value="${this.escapeHtml(param.key)}" placeholder="Parameter name">
                    </td>
                    <td>
                        <input type="text" class="param-value" value="${this.escapeHtml(param.value)}" placeholder="Parameter value">
                    </td>
                    <td>
                        <button class="button-with-icon remove-row-btn" title="Remove parameter">
                            <span class="codicon codicon-trash"></span>
                        </button>
                    </td>
                </tr>
            `).join('');

            // Заменяем технические плейсхолдеры как в PhaseSwitcher
            htmlContent = htmlContent.replace(/\$\{nonce\}/g, nonce);
            htmlContent = htmlContent.replace('${stylesUri}', stylesUri.toString());
            htmlContent = htmlContent.replace('${scriptUri}', scriptUri.toString());
            htmlContent = htmlContent.replace('${codiconsUri}', codiconsUri.toString());
            htmlContent = htmlContent.replace(/\$\{webview.cspSource\}/g, webview.cspSource);
            htmlContent = htmlContent.replace('${parametersRows}', parametersRows);
            htmlContent = htmlContent.replace('${parametersJson}', JSON.stringify(parameters));
            htmlContent = htmlContent.replace('${defaultParametersJson}', JSON.stringify(this.getDefaultParameters()));
            
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
