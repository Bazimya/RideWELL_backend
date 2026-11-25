import { DeliveryError, postJson, retryableStatus, type FetchLike, type SmsAdapter, type SmsMessage } from './types.js';

/**
 * Pindo SMS (https://docs.pindo.ai/docs/messaging/reference).
 * POST https://api.pindo.io/v1/sms/ with `Authorization: Bearer <token>` and
 * `{ to, text, sender }`. Success is 201 with `{ sms_id, status: "sent", ... }`.
 * Documented refusals: 401 bad token; 409 unsupported country, unsupported telco
 * or wrong number format. Neither can succeed on retry.
 * NOT YET VERIFIED against the live API: no token yet.
 */
export class PindoSmsAdapter implements SmsAdapter {
  readonly name = 'pindo';
  constructor(
    private readonly token: string,
    private readonly sender: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly baseUrl = 'https://api.pindo.io',
  ) {}

  async send(msg: SmsMessage) {
    const res = await postJson(this.fetchImpl, `${this.baseUrl}/v1/sms/`, { Authorization: `Bearer ${this.token}` }, { to: msg.to, text: msg.text, sender: this.sender });
    if (!res.ok) {
      const reason = res.status === 401 ? 'unauthorized (check PINDO_API_TOKEN)' : res.status === 409 ? 'number refused (unsupported country, telco or format)' : `HTTP ${res.status}`;
      throw new DeliveryError(`pindo: ${reason}`, retryableStatus(res.status), res.status);
    }
    const id = res.json?.sms_id;
    return { providerMessageId: id === undefined || id === null ? null : String(id) };
  }
}
