import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiRequest, apiRequestPage, apiRequestPageBody } from './client';
import { ApiError, apiErrorMessage, isRetryableApiError } from './errors';

/**
 * The HTTP client.
 *
 * `fetch` is stubbed rather than pointed at a server, so the cases worth testing
 * are reachable: a 502 from a proxy that returns HTML, a 204 with no body, a 2xx
 * that is not the documented envelope, and a request that never arrives. Those
 * are the paths a happy-path integration test never sees.
 */

const ENV = {
  VITE_APP_URL: 'http://localhost:5173',
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'test-key',
  VITE_STELLAR_NETWORK: 'testnet',
  VITE_STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
  VITE_FACTORY_CONTRACT_ID: '',
  VITE_USDC_CONTRACT_ID: '',
  VITE_EXPLORER_BASE_URL: 'https://stellar.expert/explorer/testnet',
  VITE_API_BASE_URL: 'https://api.example.test/api/v1',
};

vi.mock('../env', () => ({
  getEnv: () => ENV,
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('response body size limit', () => {
  const cap = 1_048_576;
  const encoder = new TextEncoder();

  function streamResponse(chunks: Uint8Array[], cancel = vi.fn(), status = 200) {
    let index = 0;
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    });
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      status,
    });
    return { response, pull, cancel };
  }

  it('accepts JSON whose UTF-8 body is exactly 1 MiB', async () => {
    const value = 'x'.repeat(cap - JSON.stringify({ data: '' }).length);
    fetchMock.mockResolvedValue(jsonResponse(200, { data: value }));
    await expect(apiRequest('groups')).resolves.toBe(value);
  });

  it('rejects a body one byte over the limit with a clear ApiError', async () => {
    fetchMock.mockResolvedValue(new Response('x'.repeat(cap + 1)));
    await expect(apiRequest('groups')).rejects.toMatchObject({
      name: 'ApiError',
      status: 200,
      code: 'response_too_large',
      message: expect.stringMatching(/1048576.*byte.*limit/i),
    });
  });

  it('cancels an oversized chunked stream before requesting more data', async () => {
    const { response, pull, cancel } = streamResponse([
      new Uint8Array(cap),
      new Uint8Array(1),
      encoder.encode('must not be read'),
    ]);
    fetchMock.mockResolvedValue(response);
    await expect(apiRequest('groups')).rejects.toMatchObject({ code: 'response_too_large' });
    expect(pull).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });

  it('counts UTF-8 bytes rather than JavaScript string characters', async () => {
    const text = JSON.stringify({ data: '😀'.repeat(cap / 4) });
    expect(text.length).toBeLessThan(cap);
    fetchMock.mockResolvedValue(new Response(text));
    await expect(apiRequest('groups')).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('preserves UTF-8 code points split across stream chunks without using response.text', async () => {
    const body = encoder.encode('\uFEFF' + JSON.stringify({ data: 'café 😀' }));
    const { response } = streamResponse(Array.from(body, (byte) => new Uint8Array([byte])));
    const text = vi.spyOn(response, 'text');
    fetchMock.mockResolvedValue(response);
    await expect(apiRequest('groups')).resolves.toBe('café 😀');
    expect(text).not.toHaveBeenCalled();
    expect(response.body?.locked).toBe(false);
  });

  it('does not let an understated Content-Length bypass the streamed byte limit', async () => {
    const response = new Response('x'.repeat(cap + 1), { headers: { 'content-length': '1' } });
    fetchMock.mockResolvedValue(response);
    await expect(apiRequest('groups')).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('uses the actual body size rather than rejecting a small body on an overstated header', async () => {
    const response = jsonResponse(200, { data: 'small' });
    response.headers.set('content-length', String(cap + 1));
    fetchMock.mockResolvedValue(response);
    await expect(apiRequest('groups')).resolves.toBe('small');
  });

  it.each([apiRequestPage, apiRequestPageBody])(
    'caps paginated callers too (%#)',
    async (request) => {
      fetchMock.mockResolvedValue(new Response('x'.repeat(cap + 1)));
      await expect(request('groups')).rejects.toMatchObject({ code: 'response_too_large' });
    },
  );

  it('reports an oversized error body clearly without making it retryable', async () => {
    fetchMock.mockResolvedValue(new Response('x'.repeat(cap + 1), { status: 502 }));
    const error = await apiRequest('groups').catch((failure: unknown) => failure);
    expect(error).toMatchObject({ status: 502, code: 'response_too_large' });
    expect(apiErrorMessage(error)).toBe('The server response was too large.');
    expect(isRetryableApiError(error)).toBe(false);
  });

  it('preserves an abort raised while reading the body and releases the reader', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(abort);
        },
      }),
    );
    fetchMock.mockResolvedValue(response);
    await expect(apiRequest('groups')).rejects.toBe(abort);
    expect(response.body?.locked).toBe(false);
  });

  it('does not let failed stream cancellation hide the size error', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('cancel failed'));
    const { response } = streamResponse([new Uint8Array(cap + 1)], cancel);
    fetchMock.mockResolvedValue(response);
    await expect(apiRequest('groups')).rejects.toMatchObject({ code: 'response_too_large' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects overflow without waiting for stream cancellation to finish', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const { response } = streamResponse([new Uint8Array(cap + 1)], cancel);
    fetchMock.mockResolvedValue(response);
    await expect(apiRequest('groups')).rejects.toMatchObject({ code: 'response_too_large' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });
});

describe('apiRequest', () => {
  it('unwraps the data envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { code: 'abc' } }));

    const result = await apiRequest<{ code: string }>('invites');

    expect(result).toEqual({ code: 'abc' });
  });

  it('builds the URL from the base and path without doubling the slash', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: null }));

    await apiRequest('/invites/redeem');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/invites/redeem',
      expect.anything(),
    );
  });

  it('sends the token as a bearer header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: null }));

    await apiRequest('me', { token: 'a-session-token' });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer a-session-token',
    );
  });

  it('sends no authorization header without a token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: null }));

    await apiRequest('groups');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('serialises a body and declares it JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: null }));

    await apiRequest('invites/redeem', { method: 'POST', body: { code: 'abc' } });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe('{"code":"abc"}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('resolves with nothing for a 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    // A 204 has no body by definition; requiring an envelope would fail on the
    // one response shape that cannot have one.
    await expect(apiRequest('notifications/x/read', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('reports the API’s error code', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'invite_not_found' }));

    await expect(apiRequest('invites/redeem', { method: 'POST', body: {} })).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'invite_not_found',
    });
  });

  it('reports a non-JSON failure by its status', async () => {
    // A 502 from a proxy is HTML, and parsing it would throw a SyntaxError that
    // says nothing about what happened.
    fetchMock.mockResolvedValue(
      new Response('<html>bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    await expect(apiRequest('groups')).rejects.toMatchObject({ status: 502, code: undefined });
  });

  it('reports a request that never arrived as status 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(apiRequest('groups')).rejects.toMatchObject({ status: 0 });
  });

  it('re-throws an abort unchanged', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    fetchMock.mockRejectedValue(abort);

    // A cancellation is not a failure, and React Query needs to recognise it as
    // one to avoid reporting an error to the user.
    await expect(apiRequest('groups')).rejects.toBe(abort);
  });

  it('refuses a 2xx that is not the documented envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { unexpected: true }));

    // Returning `undefined` here would make a contract mismatch look like a
    // successful call that produced nothing.
    await expect(apiRequest('groups')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('apiRequestPage', () => {
  it('returns the rows and the page position together', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [{ contractId: 'C1' }, { contractId: 'C2' }],
        page: { limit: 20, offset: 0, hasMore: true },
      }),
    );

    const page = await apiRequestPage<{ contractId: string }>('groups');

    expect(page.items).toEqual([{ contractId: 'C1' }, { contractId: 'C2' }]);
    expect(page.hasMore).toBe(true);
    expect(page.limit).toBe(20);
    expect(page.offset).toBe(0);
  });

  it('reports the end of a list', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: [], page: { limit: 20, offset: 40, hasMore: false } }),
    );

    const page = await apiRequestPage('groups');

    // An empty page is a definite answer, not an error: it is what the last page
    // of a list looks like.
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('refuses a list body with no page', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ contractId: 'C1' }] }));

    // Treating this as a complete list would render one row and no way to reach
    // the rest, which reads as "that is everything".
    await expect(apiRequestPage('groups')).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses a page whose hasMore is not a boolean', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: [], page: { limit: 20, offset: 0, hasMore: 'false' } }),
    );

    // A stringified boolean would make `hasMore === true` false and silently
    // present the first page as the last.
    await expect(apiRequestPage('groups')).rejects.toBeInstanceOf(ApiError);
  });

  it('reports the API’s error code for a refusal', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'group_not_found' }));

    await expect(apiRequestPage('groups/nope')).rejects.toMatchObject({
      status: 404,
      code: 'group_not_found',
    });
  });

  it('reports an unreachable server as status 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(apiRequestPage('groups')).rejects.toMatchObject({ status: 0 });
  });
});

describe('apiErrorMessage', () => {
  it('explains an unknown code without quoting the code', () => {
    const message = apiErrorMessage(new ApiError(404, 'invite_not_found', 'raw'));

    expect(message).toBe('This invite link is not valid any more.');
    expect(message).not.toContain('invite_not_found');
  });

  it('falls back for a code it does not know', () => {
    expect(apiErrorMessage(new ApiError(400, 'something_new', 'raw'))).toBe(
      'Something went wrong. Try again.',
    );
  });

  it('distinguishes an unreachable server from a refusal', () => {
    expect(apiErrorMessage(new ApiError(0, undefined, 'raw'))).toContain('reach the server');
  });

  it('passes through a plain Error’s message', () => {
    expect(apiErrorMessage(new Error('Connect a wallet first.'))).toBe('Connect a wallet first.');
  });

  it('says something for a non-Error', () => {
    expect(apiErrorMessage('a string')).toBe('Something went wrong. Try again.');
  });
});

describe('isRetryableApiError', () => {
  it('retries a server fault, a rate limit, and an unreachable server', () => {
    expect(isRetryableApiError(new ApiError(500, undefined, 'x'))).toBe(true);
    expect(isRetryableApiError(new ApiError(503, undefined, 'x'))).toBe(true);
    expect(isRetryableApiError(new ApiError(429, undefined, 'x'))).toBe(true);
    expect(isRetryableApiError(new ApiError(0, undefined, 'x'))).toBe(true);
  });

  it('does not retry a considered refusal', () => {
    // Repeating a 4xx unchanged produces the same answer.
    expect(isRetryableApiError(new ApiError(400, undefined, 'x'))).toBe(false);
    expect(isRetryableApiError(new ApiError(404, undefined, 'x'))).toBe(false);
    expect(isRetryableApiError(new ApiError(409, undefined, 'x'))).toBe(false);
    expect(isRetryableApiError(new ApiError(401, undefined, 'x'))).toBe(false);
  });

  it('does not treat a cancellation as retryable', () => {
    expect(isRetryableApiError(new DOMException('aborted', 'AbortError'))).toBe(false);
  });
});

describe('runtime schema validation', () => {
  const itemSchema = z.object({
    id: z.string(),
    count: z.number(),
  });

  it('validates apiRequest payload with provided schema', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { id: 'test-1', count: 42 } }));

    const result = await apiRequest('test', { schema: itemSchema });
    expect(result.id).toBe('test-1');
    expect(result.count).toBe(42);
  });

  it('throws ApiError when apiRequest payload violates schema', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: { id: 'test-1', count: 'not-a-number' } }),
    );

    await expect(apiRequest('test', { schema: itemSchema })).rejects.toBeInstanceOf(ApiError);
  });

  it('validates each page item with item schema in apiRequestPage', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [{ id: 'test-1', count: 1 }],
        page: { limit: 10, offset: 0, hasMore: false },
      }),
    );

    const page = await apiRequestPage('test', { schema: itemSchema });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.count).toBe(1);
  });

  it('throws ApiError when an item in apiRequestPage violates schema', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [{ id: 'test-1', count: 'invalid' }],
        page: { limit: 10, offset: 0, hasMore: false },
      }),
    );

    await expect(apiRequestPage('test', { schema: itemSchema })).rejects.toBeInstanceOf(ApiError);
  });

  it('validates page items in apiRequestPageBody with schema', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [{ id: 'test-1', count: 5 }],
        page: { limit: 10, offset: 0, hasMore: false },
        extraField: 'hello',
      }),
    );

    const { page, body } = await apiRequestPageBody('test', { schema: itemSchema });
    expect(page.items[0]?.id).toBe('test-1');
    expect(body.extraField).toBe('hello');
  });
});
