import { HttpError } from './classify';
import type { QueueItem, SendContext } from './types';

/**
 * Headers in any form `fetch` accepts: a plain object, an array of
 * `[name, value]` pairs, or a `Headers` instance (anything with `forEach`).
 */
export type HeadersLike =
  | Record<string, string>
  | ReadonlyArray<readonly [string, string]>
  | ReadonlyArray<readonly string[]>
  | { forEach(callback: (value: string, name: string) => void): void };

/** The subset of `fetch`'s `RequestInit` the sender sets or passes through. */
export interface FetchInit {
  method?: string;
  headers?: HeadersLike;
  body?: unknown;
  /** Used instead of the attempt's own signal when given. */
  signal?: unknown;
  [option: string]: unknown;
}

/** The headers as `[name, value]` pairs, in their order. */
function headerPairs(headers: HeadersLike | undefined): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  if (!headers) return pairs;
  if (Array.isArray(headers)) {
    for (const pair of headers as ReadonlyArray<readonly string[]>) {
      if (pair && pair.length >= 2) pairs.push([String(pair[0]), String(pair[1])]);
    }
  } else if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
    (headers as { forEach(callback: (value: string, name: string) => void): void }).forEach((value, name) => {
      pairs.push([String(name), String(value)]);
    });
  } else {
    const record = headers as Record<string, string>;
    for (const name of Object.keys(record)) pairs.push([name, String(record[name])]);
  }
  return pairs;
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
 *   `init.headers` may be an object, an array of pairs or a `Headers` instance;
 * - passes the attempt's `signal`, so an attempt that times out is aborted;
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
    for (const [name, value] of headerPairs(base.headers)) {
      // Never let a caller's header override the item's key.
      if (name.toLowerCase() === headerName.toLowerCase()) continue;
      if (name.toLowerCase() === 'content-type') hasContentType = true;
      headers[name] = value;
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
    const request: Record<string, unknown> = { ...base, method: base.method || 'POST', headers, body };
    if (base.signal === undefined && context.signal !== undefined) request.signal = context.signal;
    const response = await doFetch(typeof url === 'function' ? url(item) : url, request);
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
