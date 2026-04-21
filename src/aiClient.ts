import * as http from 'node:http';
import * as https from 'node:https';
import * as vscode from 'vscode';

export type AiApiFormat = 'responses' | 'chatCompletions';
export type AiOutputLanguage = 'ru' | 'en';

export interface AiConnectionSettings {
    apiFormat: AiApiFormat;
    baseUrl: string;
    apiVersion: string;
    apiKey: string;
    model: string;
    outputLanguage: AiOutputLanguage;
    timeoutMs: number;
}

export function getAiConnectionSettings(scopeUri: vscode.Uri): AiConnectionSettings {
    const config = vscode.workspace.getConfiguration('kotTestToolkit.ai', scopeUri);
    const timeoutSeconds = Math.max(5, config.get<number>('timeoutSeconds', 120));

    return {
        apiFormat: config.get<AiApiFormat>('apiFormat', 'chatCompletions'),
        baseUrl: config.get<string>('baseUrl', 'http://localhost:1234/v1').trim(),
        apiVersion: config.get<string>('apiVersion', '').trim(),
        apiKey: config.get<string>('apiKey', '').trim(),
        model: config.get<string>('model', '').trim(),
        outputLanguage: config.get<AiOutputLanguage>('outputLanguage', 'ru'),
        timeoutMs: timeoutSeconds * 1000
    };
}

export function ensureAiConnectionSettingsComplete(settings: AiConnectionSettings): void {
    const missingSettings: string[] = [];

    if (settings.baseUrl.length === 0) {
        missingSettings.push('baseUrl');
    }
    if (settings.apiKey.length === 0) {
        missingSettings.push('apiKey');
    }
    if (settings.model.length === 0) {
        missingSettings.push('model');
    }

    if (missingSettings.length > 0) {
        throw new Error(vscode.l10n.t(
            'AI settings are incomplete. Fill in: {0}.',
            missingSettings.join(', ')
        ));
    }
}

export function buildAiEndpoint(baseUrl: string, apiFormat: AiApiFormat, apiVersion?: string): string {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
    const path = apiFormat === 'chatCompletions' ? '/chat/completions' : '/responses';
    const query = apiVersion ? `?api-version=${encodeURIComponent(apiVersion)}` : '';
    return `${normalizedBaseUrl}${path}${query}`;
}

export async function requestTextFromAi(
    endpoint: string,
    settings: AiConnectionSettings,
    systemPrompt: string,
    prompt: string
): Promise<string> {
    const payload = settings.apiFormat === 'chatCompletions'
        ? {
            model: settings.model,
            messages: [
                {
                    role: 'system',
                    content: systemPrompt
                },
                {
                    role: 'user',
                    content: prompt
                }
            ]
        }
        : {
            model: settings.model,
            instructions: systemPrompt,
            input: prompt
        };

    const responseBody = await postJson<unknown>(endpoint, settings.apiKey, payload, settings.timeoutMs);
    return extractResponseText(responseBody, settings.apiFormat);
}

function extractErrorMessage(responseBody: unknown, fallbackMessage: string): string {
    if (typeof responseBody !== 'object' || responseBody === null) {
        return fallbackMessage;
    }

    const errorRecord = (responseBody as Record<string, unknown>).error;
    if (typeof errorRecord !== 'object' || errorRecord === null) {
        return fallbackMessage;
    }

    const message = (errorRecord as Record<string, unknown>).message;
    return typeof message === 'string' && message.trim().length > 0
        ? message.trim()
        : fallbackMessage;
}

function extractResponseText(responseBody: unknown, apiFormat: AiApiFormat): string {
    if (typeof responseBody !== 'object' || responseBody === null) {
        return '';
    }

    const payload = responseBody as Record<string, unknown>;
    if (apiFormat === 'responses') {
        if (typeof payload.output_text === 'string' && payload.output_text.trim().length > 0) {
            return payload.output_text.trim();
        }

        const outputItems = Array.isArray(payload.output) ? payload.output : [];
        const textParts: string[] = [];
        for (const item of outputItems) {
            if (typeof item !== 'object' || item === null) {
                continue;
            }

            const contentParts = Array.isArray((item as Record<string, unknown>).content)
                ? (item as Record<string, unknown>).content as unknown[]
                : [];

            for (const contentPart of contentParts) {
                if (typeof contentPart !== 'object' || contentPart === null) {
                    continue;
                }

                const typedPart = contentPart as Record<string, unknown>;
                if (
                    (typedPart.type === 'output_text' || typedPart.type === 'text') &&
                    typeof typedPart.text === 'string'
                ) {
                    textParts.push(typedPart.text);
                }
            }
        }

        return textParts.join('\n').trim();
    }

    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    if (typeof choice !== 'object' || choice === null) {
        return '';
    }

    const message = (choice as Record<string, unknown>).message;
    if (typeof message !== 'object' || message === null) {
        return '';
    }

    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') {
        return content.trim();
    }

    if (!Array.isArray(content)) {
        return '';
    }

    return content
        .map(part => {
            if (typeof part === 'string') {
                return part;
            }
            if (typeof part !== 'object' || part === null) {
                return '';
            }
            const typedPart = part as Record<string, unknown>;
            return typeof typedPart.text === 'string' ? typedPart.text : '';
        })
        .join('\n')
        .trim();
}

function postJson<TResponse>(
    urlString: string,
    apiKey: string,
    payload: unknown,
    timeoutMs: number
): Promise<TResponse> {
    return new Promise((resolve, reject) => {
        let url: URL;
        try {
            url = new URL(urlString);
        } catch {
            reject(new Error(vscode.l10n.t('Invalid AI base URL: {0}', urlString)));
            return;
        }

        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            reject(new Error(vscode.l10n.t('AI base URL must use http or https: {0}', urlString)));
            return;
        }

        const requestBody = JSON.stringify(payload);
        const requestImpl = url.protocol === 'https:' ? https.request : http.request;

        const request = requestImpl({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port.length > 0 ? Number(url.port) : undefined,
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(requestBody),
                'Content-Type': 'application/json',
                'User-Agent': 'KOTTestToolkit'
            }
        }, response => {
            const chunks: Buffer[] = [];

            response.on('data', chunk => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });

            response.on('end', () => {
                const responseText = Buffer.concat(chunks).toString('utf8');
                let parsedBody: unknown = null;

                if (responseText.trim().length > 0) {
                    try {
                        parsedBody = JSON.parse(responseText);
                    } catch {
                        parsedBody = responseText;
                    }
                }

                const statusCode = response.statusCode ?? 0;
                if (statusCode < 200 || statusCode >= 300) {
                    reject(new Error(vscode.l10n.t(
                        'AI request failed with status {0}: {1}',
                        String(statusCode),
                        extractErrorMessage(parsedBody, responseText || vscode.l10n.t('Empty response body'))
                    )));
                    return;
                }

                resolve(parsedBody as TResponse);
            });
        });

        request.on('error', error => {
            reject(error);
        });

        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(vscode.l10n.t(
                'AI request timed out after {0} seconds.',
                String(Math.round(timeoutMs / 1000))
            )));
        });

        request.write(requestBody);
        request.end();
    });
}
