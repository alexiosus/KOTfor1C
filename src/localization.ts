import * as vscode from 'vscode';

export type Translator = (message: string, ...args: string[]) => string;

/**
 * Returns a translator function that respects extension language override
 * (kotTestToolkit.localization.languageOverride). Falls back to vscode.l10n.
 */
export async function getTranslator(extensionUri: vscode.Uri): Promise<Translator> {
  const override = (vscode.workspace
    .getConfiguration('kotTestToolkit.localization')
    .get<string>('languageOverride') as 'System' | 'English' | 'Русский') || 'System';

  if (override === 'System') {
    return (message: string, ...args: string[]) => vscode.l10n.t(message, ...args);
  }

  if (override === 'Русский') {
    try {
      const ruUri = vscode.Uri.joinPath(extensionUri, 'l10n', 'bundle.l10n.ru.json');
      const bytes = await vscode.workspace.fs.readFile(ruUri);
      const bundle = JSON.parse(Buffer.from(bytes).toString('utf-8')) as Record<string, string>;
      return (message: string, ...args: string[]) => formatWithArgs(bundle[message] || message, args);
    } catch (e) {
      // Fallback to system if loading fails
      return (message: string, ...args: string[]) => vscode.l10n.t(message, ...args);
    }
  }

  // en override: return default English strings
  return (message: string, ...args: string[]) => formatWithArgs(message, args);
}

function formatWithArgs(template: string, args: string[]): string {
  return template.replace(/\{(\d+)\}/g, (m, idx) => {
    const i = Number(idx);
    return i >= 0 && i < args.length ? args[i] : m;
  });
}


