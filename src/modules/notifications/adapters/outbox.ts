import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { EmailAdapter, EmailMessage, SmsAdapter, SmsMessage } from './types.js';

/**
 * DEVELOPMENT AND TEST ONLY. Writes messages to `<OUTBOX_DIR>/<channel>.jsonl`
 * instead of sending them, so OTPs can be read locally while no SMS provider is
 * chosen. loadEnv() refuses to start production with this adapter.
 */
async function append(dir: string, channel: string, record: object): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const id = crypto.randomUUID();
  await fs.appendFile(path.join(dir, `${channel}.jsonl`), `${JSON.stringify({ id, at: new Date().toISOString(), ...record })}\n`, {
    mode: 0o600,
  });
  return id;
}

export class OutboxSmsAdapter implements SmsAdapter {
  readonly name = 'outbox';
  constructor(private readonly dir: string) {}
  async send(msg: SmsMessage) {
    return { providerMessageId: await append(this.dir, 'sms', msg) };
  }
}

export class OutboxEmailAdapter implements EmailAdapter {
  readonly name = 'outbox';
  constructor(private readonly dir: string) {}
  async send(msg: EmailMessage) {
    return { providerMessageId: await append(this.dir, 'email', msg) };
  }
}

/** Test helper: read messages written to the outbox. */
export async function readOutbox(dir: string, channel: 'sms' | 'email'): Promise<Array<Record<string, string>>> {
  try {
    const raw = await fs.readFile(path.join(dir, `${channel}.jsonl`), 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
