import * as vscode from 'vscode';

export class SettingsProvider {
    private static instance: SettingsProvider;
    private _context: vscode.ExtensionContext;

    private constructor(context: vscode.ExtensionContext) {
        this._context = context;
    }

    public static getInstance(context: vscode.ExtensionContext): SettingsProvider {
        if (!SettingsProvider.instance) {
            SettingsProvider.instance = new SettingsProvider(context);
        }
        return SettingsProvider.instance;
    }

    /**
     * Регистрирует команду для открытия YAML параметров из настроек
     */
    public registerSettingsProvider(): void {
        // Регистрируем команду для открытия YAML параметров из настроек
        this._context.subscriptions.push(
            vscode.commands.registerCommand('kotTestToolkit.openYamlParametersFromSettings', async () => {
                try {
                    const { YamlParametersManager } = await import('./yamlParametersManager.js');
                    const manager = YamlParametersManager.getInstance(this._context);
                    await manager.openYamlParametersPanel();
                } catch (error) {
                                console.error('[SettingsProvider] Error opening Build Scenario Parameters Manager:', error);
            vscode.window.showErrorMessage(`Error opening Build Scenario Parameters Manager: ${error}`);
                }
            })
        );
    }
}
