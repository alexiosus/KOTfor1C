/** Remove entire credential-bearing lines, rather than trying to preserve arbitrary quoted values. */
export function redactVanessaDiagnosticText(text: string): string {
    let continuation: { indentation: number; awaitingValue: boolean } | undefined;
    return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').split(/\r\n|\r|\n/u).map(line => {
        let check = line;
        for (let n = 0; n < 2; n++) { try { check = decodeURIComponent(check); } catch { break; } }
        check = check.replace(/\\+["']/gu, '"');
        const secret = /(?:^|[\s"'|;?&,\[{])(?:--?)?(?:[a-z\d]+[_-])*(?:password|pwd|пароль|token|api[_ -]?key|authorization|secret|access[_-]?token|refresh[_-]?token)\s*["']?\s*(?:[:=]|(?=\s+\S))/iu.test(check)
            || /\bBearer\s+\S+|(?:^|[\s"'\[,])\/P\S*|https?:\/\/[^\s/]+:[^\s/]*@/iu.test(check)
            || /строка подключения|строка соединения с информационной базой|дополнительные параметры|connection string|additional parameters/iu.test(check);
        const indentation = /^\s*/u.exec(check)![0].length;
        if (secret) {
            continuation = /[:=]\s*(?:[|>][-+]?|[\[{])?\s*$/u.test(check) ? { indentation, awaitingValue: true } : undefined;
            return '[redacted]';
        }
        if (continuation && check.trim()) {
            if (continuation.awaitingValue || indentation > continuation.indentation) {
                continuation.awaitingValue = false; return '[redacted]';
            }
            continuation = undefined;
        }
        return line;
    }).join('\n');
}
