import * as vscode from 'vscode';

let extensionUriValue: vscode.Uri | null = null;

export function setExtensionUri(uri: vscode.Uri) {
  extensionUriValue = uri;
}

export function getExtensionUri(): vscode.Uri {
  if (!extensionUriValue) {
    throw new Error('Extension URI not initialized');
  }
  return extensionUriValue;
}


