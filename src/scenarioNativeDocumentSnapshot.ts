/** VS Code keeps the file BOM outside getText() and uses one EOL for its lines. */
export function nativeDocumentTextMatchesFileText(documentText: string, fileText: string): boolean {
    const nativeFileText = fileText.replace(/^\uFEFF/u, '');
    const lines = (text: string) => text.replace(/\r\n|\r|\n/gu, '\n');
    return lines(documentText) === lines(nativeFileText);
}
