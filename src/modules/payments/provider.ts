import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { PaymentModel } from './payment.model.js';

/**
 * Every payment provider (Paypack in Phase 5, cards later) implements this. The
 * booking flow never talks to a provider directly.
 */
export interface PaymentProvider {
  readonly name: 'dev';
  readonly isDevelopment: boolean;
  /** Ask the provider to collect `amountRwf` (e.g. a MoMo push). Returns the provider's reference. */
  requestPayment(input: { reference: string; amountRwf: number; phone: string | null }): Promise<{ providerRef: string }>;
  /** Ask the provider for the authoritative status, amount and fee of a payment. */
  getStatus(providerRef: string): Promise<{ status: 'pending' | 'successful' | 'failed'; amountRwf: number | null; feeRwf?: number }>;
  /** Send money back to the customer for a completed payment. */
  refund(input: { paymentProviderRef: string; amountRwf: number; reference: string }): Promise<{ providerRef: string; status: 'pending' | 'successful' | 'failed' }>;
}

/**
 * DEVELOPMENT ONLY. Stands in for a real provider so bookings can be tested end to
 * end: every request "succeeds" for exactly the amount requested, and no money
 * moves. Refused in production (env.ts). Payments it creates are marked
 * `isDevelopment: true` and shown as development payments everywhere.
 */
export class DevPaymentProvider implements PaymentProvider {
  readonly name = 'dev' as const;
  readonly isDevelopment = true;

  async requestPayment(): Promise<{ providerRef: string }> {
    if (env().NODE_ENV === 'production') throw new Error('The development payment provider cannot run in production.');
    return { providerRef: `DEV-${crypto.randomUUID()}` };
  }

  async getStatus(providerRef: string) {
    if (env().NODE_ENV === 'production') throw new Error('The development payment provider cannot run in production.');
    const p = await PaymentModel.findOne({ providerRef }).lean();
    return p ? { status: 'successful' as const, amountRwf: p.amountRwf, feeRwf: 0 } : { status: 'failed' as const, amountRwf: null };
  }

  async refund(): Promise<{ providerRef: string; status: 'successful' }> {
    if (env().NODE_ENV === 'production') throw new Error('The development payment provider cannot run in production.');
    return { providerRef: `DEV-REFUND-${crypto.randomUUID()}`, status: 'successful' };
  }
}

let instance: PaymentProvider | null = null;
export function paymentProvider(): PaymentProvider {
  if (!instance) instance = new DevPaymentProvider();
  return instance;
}

/** Test helper: substitute a provider (e.g. one that reports a wrong amount). */
export function setPaymentProviderForTests(p: PaymentProvider | null): void {
  instance = p;
}
