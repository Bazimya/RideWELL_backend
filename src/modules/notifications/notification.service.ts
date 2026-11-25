import en from './messages/en.json' with { type: 'json' };
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { maskPhone } from '../../lib/phone.js';
import { OutboxEmailAdapter, OutboxSmsAdapter } from './adapters/outbox.js';
import { PindoSmsAdapter } from './adapters/pindo.js';
import { ResendEmailAdapter } from './adapters/resend.js';
import { DeliveryError, type EmailAdapter, type SmsAdapter } from './adapters/types.js';
import { MAX_ATTEMPTS, NOTIFICATION_RETENTION_DAYS, NotificationModel, RETRY_DELAYS_MS } from './notification.model.js';

/**
 * Notification service. Booking, auth and partner code call notify*() with a
 * message key; the adapter for each channel is picked from configuration, so
 * changing SMS or email provider never touches business logic.
 *
 * Messages carry only what the recipient needs: no ID numbers or full addresses in SMS.
 */

type MessageKey = keyof typeof en;
type Locale = 'en';
const catalogs: Record<Locale, Record<string, string>> = { en };

/** Variables that must never be stored: masked in the inbox copy. */
const SECRET_VARS: Record<string, string[]> = { 'trip.assigned': ['pin'] };

export function renderMessage(key: MessageKey, vars: Record<string, string | number> = {}, locale: Locale = 'en'): string {
  const template = catalogs[locale][key] ?? catalogs.en[key];
  if (!template) throw new Error(`Unknown message key ${key}`);
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!(name in vars)) throw new Error(`Message ${key} is missing variable ${name}`);
    return String(vars[name]);
  });
}

let smsAdapter: SmsAdapter | null = null;
let emailAdapter: EmailAdapter | null = null;

function sms(): SmsAdapter {
  if (!smsAdapter) {
    const e = env();
    smsAdapter = e.SMS_PROVIDER === 'pindo' ? new PindoSmsAdapter(e.PINDO_API_TOKEN!, e.PINDO_SENDER_ID) : new OutboxSmsAdapter(e.OUTBOX_DIR);
  }
  return smsAdapter;
}

function email(): EmailAdapter {
  if (!emailAdapter) {
    const e = env();
    emailAdapter = e.EMAIL_PROVIDER === 'resend' ? new ResendEmailAdapter(e.RESEND_API_KEY!, e.EMAIL_FROM!, e.EMAIL_REPLY_TO) : new OutboxEmailAdapter(e.OUTBOX_DIR);
  }
  return emailAdapter;
}

/** Test helper: reset, or swap in adapters. */
export function resetNotificationAdapters(adapters: { sms?: SmsAdapter; email?: EmailAdapter } = {}): void {
  smsAdapter = adapters.sms ?? null;
  emailAdapter = adapters.email ?? null;
}

export function providerNames() {
  const e = env();
  return { sms: e.SMS_PROVIDER, email: e.EMAIL_PROVIDER, isDevelopment: e.SMS_PROVIDER === 'outbox' || e.EMAIL_PROVIDER === 'outbox' };
}

/** Direct send, not stored. Used for sign-in codes and staff alerts. */
export async function sendSms(to: string, key: MessageKey, vars: Record<string, string | number> = {}): Promise<void> {
  const text = renderMessage(key, vars);
  const adapter = sms();
  const res = await adapter.send({ to, text });
  logger.info({ channel: 'sms', provider: adapter.name, key, to: maskPhone(to), providerMessageId: res.providerMessageId }, 'notification sent');
}

export async function sendEmail(to: string, subjectKey: MessageKey, textKey: MessageKey, vars: Record<string, string | number> = {}): Promise<void> {
  const adapter = email();
  const res = await adapter.send({ to, subject: renderMessage(subjectKey, vars), text: renderMessage(textKey, vars) });
  logger.info({ channel: 'email', provider: adapter.name, key: textKey, providerMessageId: res.providerMessageId }, 'notification sent');
}

export function maskEmail(address: string): string {
  const [local = '', domain = ''] = address.split('@');
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, local.length - 2)))}@${domain}`;
}

/** Inbox copy: drop the "RideWELL: " SMS prefix, which the app already shows. */
const inboxText = (text: string) => text.replace(/^RideWELL:\s*/, '');

export interface NotifyOptions {
  /** App path the message is about, e.g. /bookings/<id>. */
  link?: string | null;
  /** Unique per real-world event: the same key notifies once. */
  dedupeKey?: string;
}

/**
 * Notify a user: an inbox entry in the app, plus SMS when the account has a phone,
 * otherwise email. Called after the change it reports has been committed. A failed
 * delivery is retried by the notifications job and never undoes the change.
 */
export async function notifyUser(userId: string, key: string, vars: Record<string, string | number> = {}, opts: NotifyOptions = {}): Promise<void> {
  try {
    const { UserModel } = await import('../users/user.model.js');
    const user = await UserModel.findById(userId).select('phone email status').lean();
    if (!user || user.status === 'anonymised') return;
    const k = key as MessageKey;
    const secrets = SECRET_VARS[key] ?? [];
    const stored = { ...vars };
    for (const s of secrets) if (s in stored) stored[s] = '••••';
    const channel = user.phone ? 'sms' : user.email ? 'email' : 'none';
    const subjectKey = `${key}.subject` as MessageKey;
    const title = subjectKey in en ? renderMessage(subjectKey, stored) : 'RideWELL';
    let doc;
    try {
      doc = await NotificationModel.create({
        userId,
        key,
        title,
        body: inboxText(renderMessage(k, stored)),
        link: opts.link ?? null,
        channel,
        toMasked: user.phone ? maskPhone(user.phone) : user.email ? maskEmail(user.email) : null,
        status: channel === 'none' ? 'skipped' : 'pending',
        resendable: secrets.length === 0,
        // Lease: the retry job leaves it alone while this first attempt runs.
        nextAttemptAt: channel === 'none' ? null : new Date(Date.now() + 2 * 60_000),
        dedupeKey: opts.dedupeKey,
        expireAt: new Date(Date.now() + NOTIFICATION_RETENTION_DAYS * 86_400_000),
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return; // already notified for this event
      throw err;
    }
    if (channel !== 'none') await attemptDelivery(String(doc._id), renderMessage(k, vars), title);
  } catch (err) {
    logger.error({ err, key }, 'notification failed');
  }
}

/**
 * One delivery attempt. `text` is the full message (with secrets) on the first
 * attempt; retries use the stored body, which is only possible when nothing was masked.
 */
async function attemptDelivery(id: string, text: string, title: string): Promise<void> {
  const n = await NotificationModel.findById(id);
  if (!n || n.status !== 'pending') return;
  const { UserModel } = await import('../users/user.model.js');
  const user = await UserModel.findById(n.userId).select('phone email status').lean();
  n.attempts += 1;
  try {
    if (!user || user.status === 'anonymised') throw new DeliveryError('recipient no longer available', false);
    let res: { providerMessageId: string | null };
    let provider: string;
    if (n.channel === 'sms') {
      if (!user.phone) throw new DeliveryError('account has no phone number', false);
      const a = sms();
      provider = a.name;
      res = await a.send({ to: user.phone, text });
    } else {
      if (!user.email) throw new DeliveryError('account has no email address', false);
      const a = email();
      provider = a.name;
      res = await a.send({ to: user.email, subject: title, text, idempotencyKey: `notification/${id}` });
    }
    n.status = 'sent';
    n.provider = provider;
    n.providerMessageId = res.providerMessageId;
    n.sentAt = new Date();
    n.nextAttemptAt = null;
    n.lastError = null;
    logger.info({ channel: n.channel, provider, key: n.key, providerMessageId: res.providerMessageId }, 'notification sent');
  } catch (err) {
    const retryable = err instanceof DeliveryError ? err.retryable : true;
    n.lastError = (err instanceof DeliveryError ? err.message : 'unexpected error').slice(0, 300);
    if (retryable && n.resendable && n.attempts < MAX_ATTEMPTS) {
      n.nextAttemptAt = new Date(Date.now() + RETRY_DELAYS_MS[n.attempts - 1]!);
    } else {
      n.status = 'failed';
      n.nextAttemptAt = null;
      if (retryable && !n.resendable) n.lastError = `${n.lastError} (not retried: the message held a secret)`.slice(0, 300);
    }
    logger.warn({ key: n.key, channel: n.channel, attempts: n.attempts, error: n.lastError }, 'notification delivery failed');
  }
  await n.save();
}

const body = (n: { body: string }) => (n.body.startsWith('RideWELL') ? n.body : `RideWELL: ${n.body}`);

/** Job: retry pending deliveries that are due. Claims each one so two instances never send it twice. */
export async function retryDueNotifications(now = new Date()): Promise<number> {
  let done = 0;
  for (let i = 0; i < 100; i++) {
    const n = await NotificationModel.findOneAndUpdate(
      { status: 'pending', resendable: true, nextAttemptAt: { $lte: now } },
      { $set: { nextAttemptAt: new Date(now.getTime() + 5 * 60_000) } },
      { sort: { nextAttemptAt: 1 }, new: true },
    );
    if (!n) break;
    await attemptDelivery(String(n._id), body(n), n.title);
    done++;
  }
  // Pending entries holding a secret cannot be retried from the stored copy.
  await NotificationModel.updateMany(
    { status: 'pending', resendable: false, nextAttemptAt: { $lte: new Date(now.getTime() - 60_000) } },
    { $set: { status: 'failed', nextAttemptAt: null, lastError: 'not retried: the message held a secret' } },
  );
  return done;
}

/** Staff: send a failed message again (only when it held no secret). */
export async function resendNotification(id: string): Promise<'queued' | 'not_resendable' | 'not_failed' | 'not_found'> {
  const n = await NotificationModel.findOneAndUpdate({ _id: id, status: 'failed', resendable: true }, { $set: { status: 'pending', nextAttemptAt: new Date(), attempts: 0 } }, { new: true });
  if (!n) {
    const any = await NotificationModel.findById(id).lean();
    if (!any) return 'not_found';
    return any.status !== 'failed' ? 'not_failed' : 'not_resendable';
  }
  await attemptDelivery(String(n._id), body(n), n.title);
  return 'queued';
}
