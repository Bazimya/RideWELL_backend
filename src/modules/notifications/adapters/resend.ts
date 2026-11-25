import { DeliveryError, postJson, retryableStatus, type EmailAdapter, type EmailMessage, type FetchLike } from './types.js';

/**
 * Resend (https://resend.com/docs/api-reference/emails/send-email).
 * POST https://api.resend.com/emails with `Authorization: Bearer re_…` and
 * `{ from, to, subject, text, reply_to? }`; the response is `{ id }`.
 * `Idempotency-Key` (1–256 chars, kept 24 h) makes a retry of the same message
 * return the original response instead of sending twice.
 * NOT YET VERIFIED against the live API: no key yet.
 */
export class ResendEmailAdapter implements EmailAdapter {
  readonly name = 'resend';
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly replyTo: string | undefined,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly baseUrl = 'https://api.resend.com',
  ) {}

  async send(msg: EmailMessage) {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (msg.idempotencyKey) headers['Idempotency-Key'] = msg.idempotencyKey.slice(0, 256);
    const body: Record<string, unknown> = { from: this.from, to: [msg.to], subject: msg.subject, text: msg.text };
    if (this.replyTo) body.reply_to = this.replyTo;
    const res = await postJson(this.fetchImpl, `${this.baseUrl}/emails`, headers, body);
    if (!res.ok) {
      const name = typeof res.json?.name === 'string' ? res.json.name : `HTTP ${res.status}`;
      // 409 concurrent_idempotent_requests: the first attempt is still in flight; retry later.
      const retryable = retryableStatus(res.status) || name === 'concurrent_idempotent_requests';
      throw new DeliveryError(`resend: ${name}`, retryable, res.status);
    }
    const id = res.json?.id;
    return { providerMessageId: typeof id === 'string' ? id : null };
  }
}
