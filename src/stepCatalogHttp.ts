import * as https from 'node:https';
import { StepCatalogHttpResponse } from './stepCatalogClient';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export interface FetchHttpsBytesOptions {
    readonly signal?: AbortSignal;
    readonly maxBytes: number;
    readonly etag?: string;
}

export class BoundedResponseAccumulator {
    private readonly chunks: Buffer[] = [];
    private byteLength = 0;

    public constructor(private readonly maxBytes: number) {
        if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
            throw new Error('Response maximum size must be a positive integer.');
        }
    }

    public append(chunk: Uint8Array): void {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (this.byteLength + buffer.byteLength > this.maxBytes) {
            throw new Error(`Response exceeds the maximum size of ${this.maxBytes} bytes.`);
        }
        this.chunks.push(buffer);
        this.byteLength += buffer.byteLength;
    }

    public toUint8Array(): Uint8Array {
        return Buffer.concat(this.chunks, this.byteLength);
    }
}

export function resolveCatalogRedirect(currentUrl: URL, location: string | undefined): URL {
    if (!location) {
        throw new Error('Catalog redirect response is missing the Location header.');
    }
    const redirectUrl = new URL(location, currentUrl);
    if (redirectUrl.protocol !== 'https:') {
        throw new Error('Catalog redirects must remain on HTTPS.');
    }
    return redirectUrl;
}

function responseEtag(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function requestHttpsBytes(
    url: URL,
    options: FetchHttpsBytesOptions,
    redirectCount: number
): Promise<StepCatalogHttpResponse> {
    if (url.protocol !== 'https:') {
        return Promise.reject(new Error('Step catalog requests must use HTTPS.'));
    }
    if (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0) {
        return Promise.reject(new Error('Response maximum size must be a positive integer.'));
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            action();
        };

        const request = https.request(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                ...(options.etag ? { 'If-None-Match': options.etag } : {}),
                'User-Agent': 'KOTTestToolkit'
            },
            signal: options.signal
        }, response => {
            const status = response.statusCode ?? 0;
            const etag = responseEtag(response.headers.etag);

            if (REDIRECT_STATUS_CODES.has(status)) {
                response.resume();
                let redirectUrl: URL;
                try {
                    if (redirectCount >= MAX_REDIRECTS) {
                        throw new Error(`Catalog request exceeded ${MAX_REDIRECTS} redirects.`);
                    }
                    redirectUrl = resolveCatalogRedirect(url, response.headers.location);
                } catch (error) {
                    finish(() => reject(error));
                    return;
                }
                requestHttpsBytes(redirectUrl, options, redirectCount + 1).then(
                    result => finish(() => resolve(result)),
                    error => finish(() => reject(error))
                );
                return;
            }

            if ((status < 200 || status >= 300) && status !== 304) {
                response.resume();
                finish(() => resolve({ status, body: new Uint8Array(), etag }));
                return;
            }

            const declaredLength = Number(response.headers['content-length']);
            if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
                const error = new Error(
                    `Response exceeds the maximum size of ${options.maxBytes} bytes.`
                );
                response.destroy(error);
                request.destroy(error);
                finish(() => reject(error));
                return;
            }

            const accumulator = new BoundedResponseAccumulator(options.maxBytes);
            response.on('data', (chunk: Buffer | Uint8Array | string) => {
                try {
                    accumulator.append(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
                } catch (error) {
                    response.destroy(error as Error);
                    request.destroy(error as Error);
                    finish(() => reject(error));
                }
            });
            response.on('end', () => {
                finish(() => resolve({ status, body: accumulator.toUint8Array(), etag }));
            });
            response.on('aborted', () => {
                finish(() => reject(new Error('Catalog response was aborted.')));
            });
            response.on('error', error => finish(() => reject(error)));
        });

        request.on('error', error => finish(() => reject(error)));
        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
            request.destroy(new Error('Catalog request timed out after 15 seconds.'));
        });
        request.end();
    });
}

export function fetchHttpsBytes(
    url: URL,
    options: FetchHttpsBytesOptions
): Promise<StepCatalogHttpResponse> {
    return requestHttpsBytes(url, options, 0);
}
