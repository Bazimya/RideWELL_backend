export interface SmsMessage {
  to: string; // E.164
  text: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Same key = same email: lets the provider drop a duplicate when we retry. */
  idempotencyKey?: string;
}

export interface SmsAdapter {
  readonly name: string;
  send(msg: SmsMessage): Promise<{ providerMessageId: string | null }>;
}

export interface EmailAdapter {
  readonly name: string;
  send(msg: EmailMessage): Promise<{ providerMessageId: string | null }>;
}

/**
 * A provider refused or failed a message. `retryable` is true for network errors,
 * timeouts, rate limits and 5xx; false when resending the same message cannot work
 * (bad key, unsupported or malformed number, unverified sender domain).
 */
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

/** POST JSON with a timeout; maps transport failures to retryable DeliveryErrors. */
export async function postJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, body: unknown, timeoutMs = 10_000) {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new DeliveryError(`network error: ${(err as Error).name}`, true);
  }
  const raw = await res.text().catch(() => '');
  let json: Record<string, unknown> | null = null;
  try {
    json = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json };
}

export const retryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;
