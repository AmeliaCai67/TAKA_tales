// Transport stays independent of session state and UI modules.
import { errorMessage } from './errors';

export class ApiError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
}
export interface RequestOptions { method?: string; body?: unknown; headers?: Record<string, string> }

function responseMessage(data: unknown, status: number): string {
    if (typeof data === 'object' && data !== null && 'detail' in data && data.detail) {
        return typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
    }
    return 'HTTP ' + status;
}

function xhrJson<T>(url: string, opts: RequestOptions, headers: Record<string, string>): Promise<T> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(opts.method || 'GET', url);
        for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
        xhr.timeout = 15000;
        xhr.onload = () => {
            let data: unknown;
            try { data = JSON.parse(xhr.responseText || '{}'); }
            catch { reject(new Error('Invalid JSON response')); return; }
            if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
            else reject(new ApiError(xhr.status, responseMessage(data, xhr.status)));
        };
        xhr.onerror = () => reject(new TypeError('xhr onerror (status=' + xhr.status + ')'));
        xhr.ontimeout = () => reject(new TypeError('xhr timeout'));
        xhr.send(opts.body === undefined ? undefined : JSON.stringify(opts.body));
    });
}

/** Preserve the tested mobile fetch → retry → XHR fallback. HTTP errors never retry. */
export async function requestJson<T>(url: string, opts: RequestOptions, token: string): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers };
    if (token) headers.Authorization = 'Bearer ' + token;
    let fetchError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 400));
        const controller = new AbortController();
        // Generation can take two LLM attempts plus classification on a small server.
        const timeout = setTimeout(() => controller.abort(), 120000);
        try {
            let response: Response;
            try {
                response = await fetch(url, {
                    method: opts.method || 'GET', headers,
                    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
                    cache: 'no-store', signal: controller.signal,
                });
            } catch (error) {
                if (controller.signal.aborted) throw new ApiError(408, 'Request timed out');
                fetchError = error;
                continue;
            }
            if (!response.ok) {
                const data: unknown = await response.json().catch(() => null);
                throw new ApiError(response.status, responseMessage(data, response.status));
            }
            return await response.json() as T;
        } finally { clearTimeout(timeout); }
    }
    try { return await xhrJson<T>(url, opts, headers); }
    catch (error) {
        if (error instanceof ApiError) throw error;
        throw new TypeError(errorMessage(fetchError) + '；xhr: ' + errorMessage(error));
    }
}
