/**
 * How the API reports failure, and what this app says about it.
 *
 * The API answers a failed request with a small machine-readable code —
 * `invalid_request`, `invite_not_found`, `invite_exhausted` — and never with a
 * sentence. That is deliberate: the same code has to serve a web client, a script
 * and a future mobile app, and a server that writes the user-facing copy for one of
 * them writes it badly for the others.
 *
 * So the mapping from code to English lives here, on the client, where the
 * audience is known. Anything unmapped falls back to a generic sentence rather
 * than forwarding the raw code, because `invite_not_found` is not a thing to say
 * to a person.
 *
 * THE ONE DISTINCTION WORTH KEEPING
 * `invite_exhausted` is reported differently from `invite_not_found`, matching the
 * API. An unknown, expired or revoked code gets one identical answer, because any
 * difference confirms that a guessed code is real. An exhausted code is the
 * opposite case: the caller had a real code, did nothing wrong, and the remedy —
 * ask for a new invite — is specific and useful.
 */

/** A failure reported by the API, as opposed to a network or transport failure. */
export class ApiError extends Error {
  /** The HTTP status, or `0` when the request never reached the server. */
  readonly status: number;
  /** The API's machine-readable code, when it sent one. */
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Whether retrying the same request could plausibly succeed.
 *
 * A 4xx is the server's considered answer about this request, so repeating it
 * unchanged produces the same answer. A 5xx, a 429, or a request that never
 * arrived may well work on a second attempt.
 */
export function isRetryableApiError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.code === 'response_too_large') return false;
  if (error.status === 0) return true;
  return error.status >= 500 || error.status === 429;
}

const MESSAGES: Record<string, string> = {
  response_too_large: 'The server response was too large.',
  invalid_request: 'That request was not something the server could accept.',
  unauthorized: 'Your session has expired. Sign in again and retry.',
  forbidden: 'This account is not allowed to do that.',
  not_found: 'That was not found.',
  group_not_found: 'That group is not known to the server yet.',
  invite_not_found: 'This invite link is not valid any more.',
  invite_exhausted: 'This invite has already been used as many times as it allows.',
  notification_not_found: 'That notification is no longer there.',
  transaction_not_found: 'No record of that transaction yet.',
  wallet_already_linked: 'That wallet is already linked to another account.',
  nonce_reused: 'That signature has already been used. Start the link again.',
  invalid_nonce: 'That wallet-link request has expired. Start again.',
  invalid_signature: 'The signature did not match that wallet.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
};

/** A sentence for a person, from whatever went wrong. */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) {
      return 'Could not reach the server. Check your connection and try again.';
    }
    return MESSAGES[error.code ?? ''] ?? 'Something went wrong. Try again.';
  }

  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'Something went wrong. Try again.';
}
