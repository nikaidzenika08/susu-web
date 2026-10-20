/**
 * The HTTP client for `susu-api`.
 *
 * This is the only module in the app that talks to the backend, and it is
 * deliberately thin: build a URL, attach a token, parse a JSON body, and turn a
 * non-2xx response into an `ApiError`. Every decision about what a response
 * *means* belongs in the module that called it — invite codes mean nothing to a
 * generic transport.
 *
 * TOKENS ARE PASSED IN
 * The client never reads the session itself. A caller that needs authentication
 * supplies the token, which keeps this module free of Supabase and lets the tests
 * exercise every branch without a browser session or a network.
 *
 * WHAT IS DELIBERATELY ABSENT
 * No retry, and no timeout. Retrying is a policy that depends on the operation —
 * retrying a redeemed invite is safe, retrying anything that claims a use is not
 * something this layer can judge — and the callers that need it use React Query,
 * which owns that policy. A silent client-side timeout would also be a lie about
 * what happened to the request: the browser cancels its interest, not the
 * request, so the server may still have acted.
 */
import { z } from 'zod';
import { getEnv } from '../env';
import { ApiError } from './errors';

/** The JSON envelope every successful response uses. */
type SuccessBody<T> = { data: T };

/** The envelope every failed response uses. */
type FailureBody = { error?: unknown };

/**
 * The envelope a paginated list uses: the page's rows, plus where they sit.
 *
 * Distinct from `SuccessBody` because a caller paging a list needs the second
 * half. Unwrapping `data` alone would hand back a page with no way to know
 * whether asking for the next one is worth doing.
 */
type PageBody<T> = {
  data: readonly T[];
  page: { limit?: unknown; offset?: unknown; hasMore?: unknown };
};

/**
 * One page of a paginated list.
 *
 * `hasMore` is the API's answer, not a guess from the row count: a page whose
 * length equals the limit is ambiguous — it is the last page exactly as often as
 * it is not — and guessing would either hide rows or offer a next page that is
 * empty.
 */
export type ApiPage<T> = {
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly limit: number;
  readonly offset: number;
};

export type RequestOptions<T = unknown> = {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Serialised as JSON. Omitted entirely when absent. */
  readonly body?: unknown;
  /** A Supabase access token, when the endpoint requires one. */
  readonly token?: string | undefined;
  /** Aborts the request. A cancelled request never resolves. */
  readonly signal?: AbortSignal | undefined;
  /** Optional Zod schema to runtime-validate response payload. */
  readonly schema?: z.ZodType<T> | undefined;
};

function url(path: string): string {
  const base = getEnv().VITE_API_BASE_URL;
  if (base === undefined) {
    // Named explicitly rather than letting `undefined/groups` become a relative
    // request that the dev server answers with the SPA's index.html — which
    // `readJson` would then report as "an unexpected body", hiding the cause.
    throw new ApiError(0, undefined, 'VITE_API_BASE_URL is not configured.');
  }
  // Both halves are normalised, so a base URL with a trailing slash and a path
  // without a leading one do not produce a double slash. Some proxies treat `//`
  // as a protocol-relative reference, which is a real misconfiguration rather
  // than a cosmetic problem.
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Maximum decoded response-body size, measured in UTF-8 bytes (1 MiB). */
const MAX_RESPONSE_BODY_BYTES = 1_048_576;

async function readTextBounded(response: Response): Promise<string> {
  if (response.body === null) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      if (value.byteLength > MAX_RESPONSE_BODY_BYTES - bytes) {
        // Stop requesting bytes immediately. Cancellation can itself fail or
        // remain pending; neither may hide or delay the useful size error.
        void reader.cancel().catch(() => undefined);
        throw new ApiError(
          response.status,
          'response_too_large',
          `The server response exceeds the ${MAX_RESPONSE_BODY_BYTES}-byte limit.`,
        );
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Reads a bounded response body as JSON, or `undefined` if it is not JSON.
 *
 * A 502 from a proxy is HTML, and `response.json()` on it throws a `SyntaxError`
 * that says nothing about the actual problem. Returning `undefined` lets the
 * caller report the status, which is the informative part.
 */
async function readJson(response: Response): Promise<unknown> {
  const text = await readTextBounded(response);
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function codeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const code = (body as FailureBody).error;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Performs a request and returns the parsed body, or throws `ApiError`.
 *
 * The single place the network is touched. `apiRequest` and `apiRequestPage`
 * differ only in which half of the body they read, so keeping the fetch here
 * means a change to timeouts, headers or error handling cannot apply to one and
 * be forgotten in the other.
 */
async function send(
  path: string,
  options: RequestOptions,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;

  let response: Response;
  try {
    response = await fetch(url(path), {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    // A request that never arrived is a distinct failure from one the server
    // refused, and the difference matters to the user: one is worth retrying, the
    // other is not. An abort is not a failure and is re-thrown unchanged so
    // React Query handles it as a cancellation.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, undefined, 'The request could not reach the server.');
  }

  const body = await readJson(response);

  if (!response.ok) {
    throw new ApiError(
      response.status,
      codeOf(body),
      `Request failed with status ${response.status}`,
    );
  }

  return { status: response.status, body };
}

function hasData(body: unknown): body is SuccessBody<unknown> {
  return typeof body === 'object' && body !== null && 'data' in body;
}

/**
 * Reads a paginated body, or `undefined` if it is not one.
 *
 * Every field is checked rather than trusted. A `page` that is present but shaped
 * differently — a renamed field, a stringified number — would otherwise become
 * `undefined` in an `ApiPage`, and a caller comparing `hasMore` to `true` would
 * quietly treat the end of the list as reached.
 */
function pageOf(body: unknown): ApiPage<unknown> | undefined {
  if (!hasData(body)) return undefined;

  const { data, page } = body as PageBody<unknown>;
  if (!Array.isArray(data)) return undefined;
  if (typeof page !== 'object' || page === null) return undefined;

  const { limit, offset, hasMore } = page;
  if (typeof limit !== 'number' || typeof offset !== 'number') return undefined;
  if (typeof hasMore !== 'boolean') return undefined;

  return { items: data, hasMore, limit, offset };
}

/**
 * Performs a request and returns the unwrapped `data`.
 *
 * Throws `ApiError` for anything other than a 2xx with a JSON body. A 204 has no
 * body by definition, so it resolves with `undefined` rather than failing to
 * parse.
 */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions<T> = {},
  schema?: z.ZodType<T>,
): Promise<T> {
  const { status, body } = await send(path, options);

  if (status === 204) return undefined as T;

  if (!hasData(body)) {
    // A 2xx that is not the documented envelope means this client and the server
    // disagree about the contract, which is worth failing on rather than
    // returning `undefined` as though the call had succeeded.
    throw new ApiError(status, undefined, 'The server returned an unexpected body.');
  }

  const effectiveSchema = schema ?? options.schema;
  if (effectiveSchema) {
    const result = effectiveSchema.safeParse(body.data);
    if (!result.success) {
      throw new ApiError(
        status,
        undefined,
        `The server returned an unexpected response shape: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      );
    }
    return result.data;
  }

  return body.data as T;
}

/**
 * Performs a request and returns one page of a list, `data` and `page` together.
 *
 * Separate from `apiRequest` rather than a flag on it, because the two return
 * different things and a caller should have to say which it expects.
 */
export async function apiRequestPage<T>(
  path: string,
  options: RequestOptions<T> = {},
  itemSchema?: z.ZodType<T>,
): Promise<ApiPage<T>> {
  const { status, body } = await send(path, options);

  const page = pageOf(body);
  if (page === undefined) {
    throw new ApiError(status, undefined, 'The server returned an unexpected page.');
  }

  const effectiveSchema = itemSchema ?? options.schema;
  if (effectiveSchema) {
    const validatedItems: T[] = [];
    for (let i = 0; i < page.items.length; i++) {
      const result = effectiveSchema.safeParse(page.items[i]);
      if (!result.success) {
        throw new ApiError(
          status,
          undefined,
          `The server returned an unexpected item shape at index ${i}: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ')}`,
        );
      }
      validatedItems.push(result.data);
    }
    return { ...page, items: validatedItems };
  }

  return page as ApiPage<T>;
}

/**
 * Reads a paginated body *and* the rest of it.
 *
 * `GET /notifications` answers with a page and an unread count in the same body,
 * and the count is not derivable from the rows: a filtered page does not say how
 * many unread rows lie outside it. `apiRequestPage` deliberately returns only the
 * page — every other list has nothing else to say — so this is the variant for an
 * endpoint that does.
 *
 * `pageOf` still validates the page, so a caller cannot be handed an `unreadCount`
 * from a response whose rows were shaped differently than expected.
 */
export async function apiRequestPageBody<T>(
  path: string,
  options: RequestOptions<T> = {},
  itemSchema?: z.ZodType<T>,
): Promise<{ page: ApiPage<T>; body: Record<string, unknown> }> {
  const { status, body } = await send(path, options);

  const page = pageOf(body);
  if (page === undefined) {
    throw new ApiError(status, undefined, 'The server returned an unexpected page.');
  }

  const effectiveSchema = itemSchema ?? options.schema;
  let items = page.items as T[];
  if (effectiveSchema) {
    const validatedItems: T[] = [];
    for (let i = 0; i < page.items.length; i++) {
      const result = effectiveSchema.safeParse(page.items[i]);
      if (!result.success) {
        throw new ApiError(
          status,
          undefined,
          `The server returned an unexpected item shape at index ${i}: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ')}`,
        );
      }
      validatedItems.push(result.data);
    }
    items = validatedItems;
  }

  return { page: { ...page, items }, body: body as Record<string, unknown> };
}
