import { HttpError } from './classify';
import type { QueueItem, SendContext } from './types';

/** The subset of `fetch`'s `RequestInit` the sender sets or passes through. */
export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  [option: string]: unknown;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<FetchResponseLike>;

export interface FetchSenderOptions {
  /** Header that carries the idempotency key. Default `'Idempotency-Key'`. */
  headerName?: string;
  /** Default: the global `fetch`. */
  fetch?: FetchLike;
}

function parseBody(text: string, contentType: string | null): unknown {
  if (text === '') return undefined;
  if (contentType && /[/+]json\b/i.test(contentType)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * A `send` function built on `fetch`. Each attempt:
 *
 * - uses `init.method`, or `POST`;
 * - sets the `Idempotency-Key` header (or `headerName`) to the item's key;
 * - sends `item.payload` as the body: strings as they are, anything else as
 *   JSON with `Content-Type: application/json` unless you set one;
 * - resolves with the response body (parsed when it is JSON) for 2xx, and
 *   throws an `HttpError` with `status`, `headers` and `body` otherwise, which
 *   `defaultClassifyError` understands. A network failure rejects as `fetch` does.
 *
 * The server has to honour the header: store the first response per key and
 * replay it for repeated keys, without repeating the effect. Without that, a
 * retry after a lost response repeats the effect.
 *
 * `url` and `init` may be functions of the item.
 */
export function fetchSender<TPayload = unknown, TResult = unknown>(
  url: string | ((item: QueueItem<TPayload>) => string),
  init?: FetchInit | ((item: QueueItem<TPayload>) => FetchInit),
  options: FetchSenderOptions = {},
): (item: QueueItem<TPayload>, context: SendContext) => Promise<TResult> {
  const headerName = options.headerName || 'Idempotency-Key';
  return async (item, context) => {
    const doFetch: FetchLike | undefined =
      options.fetch || (typeof fetch === 'function' ? (fetch as unknown as FetchLike) : undefined);
    if (!doFetch) throw new Error('fetchSender: no fetch implementation is available');
    const base = (typeof init === 'function' ? init(item) : init) || {};
    const headers: Record<string, string> = {};
    let hasContentType = false;
    const given = base.headers || {};
    for (const name of Object.keys(given)) {
      // Never let a caller's header override the item's key.
      if (name.toLowerCase() === headerName.toLowerCase()) continue;
      if (name.toLowerCase() === 'content-type') hasContentType = true;
      headers[name] = given[name];
    }
    headers[headerName] = context.key;
    let body: unknown = base.body;
    if (body === undefined) {
      if (typeof item.payload === 'string') {
        body = item.payload;
      } else {
        body = JSON.stringify(item.payload);
        if (!hasContentType) headers['Content-Type'] = 'application/json';
      }
    }
    const response = await doFetch(typeof url === 'function' ? url(item) : url, {
      ...base,
      method: base.method || 'POST',
      headers,
      body,
    });
    let text = '';
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    const parsed = parseBody(text, response.headers ? response.headers.get('Content-Type') : null);
    if (!response.ok) {
      throw new HttpError(
        response.status,
        `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
        response.headers,
        parsed,
      );
    }
    return parsed as TResult;
  };
}

declare const fetch: unknown;
