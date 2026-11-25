import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { postLedgerEntries, LedgerError } from '../src/modules/ledger/ledger.service.js';
import { LedgerEntryModel } from '../src/modules/ledger/ledger.model.js';
import { withTransaction } from '../src/db/transaction.js';
import { splitByBps } from '../src/lib/money.js';

const bookingId = new mongoose.Types.ObjectId();
const post = (entries: Parameters<typeof postLedgerEntries>[0]) => withTransaction((s) => postLedgerEntries(entries, s));

describe('ledger', () => {
  it('records a payment split as separate entries that add up to the payment', async () => {
    const total = 45_001;
    const split = splitByBps(total, { platform: 2000, driver: 3000, vehicle_owner: 5000 });
    await post([
      { type: 'customer_payment', party: 'customer', bookingId, amount: total, idempotencyKey: `pay:${bookingId}`, createdBySystem: 'test' },
      { type: 'platform_commission', party: 'platform', bookingId, amount: split.platform, idempotencyKey: `comm:${bookingId}`, createdBySystem: 'test' },
      { type: 'driver_earning', party: 'driver', bookingId, amount: split.driver, idempotencyKey: `drv:${bookingId}`, createdBySystem: 'test' },
      { type: 'vehicle_owner_earning', party: 'vehicle_owner', bookingId, amount: split.vehicle_owner, idempotencyKey: `veh:${bookingId}`, createdBySystem: 'test' },
    ]);
    const rows = await LedgerEntryModel.find({ bookingId }).lean();
    const allocated = rows.filter((r) => r.type !== 'customer_payment').reduce((a, r) => a + r.amount, 0);
    expect(allocated).toBe(total);
  });

  it('refuses to record the same event twice, and writes nothing from the failed batch', async () => {
    await post([{ type: 'customer_payment', party: 'customer', amount: 1000, idempotencyKey: 'evt-1', createdBySystem: 'test' }]);
    await expect(
      post([
        { type: 'provider_fee', party: 'payment_provider', amount: 20, idempotencyKey: 'evt-2', createdBySystem: 'test' },
        { type: 'customer_payment', party: 'customer', amount: 1000, idempotencyKey: 'evt-1', createdBySystem: 'test' },
      ]),
    ).rejects.toMatchObject({ code: 'duplicate_event' });
    expect(await LedgerEntryModel.countDocuments()).toBe(1); // the transaction rolled back evt-2 too
  });

  it('refuses non-integer, zero and negative amounts (except corrections)', async () => {
    for (const amount of [10.5, 0, -100, Number.NaN, 2_000_000_000]) {
      await expect(
        post([{ type: 'driver_earning', party: 'driver', amount, idempotencyKey: `bad-${amount}`, createdBySystem: 'test' }]),
      ).rejects.toBeInstanceOf(LedgerError);
    }
  });

  it('allows a negative reversal only when it points at the entry it corrects', async () => {
    const [orig] = await post([{ type: 'driver_earning', party: 'driver', amount: 5000, idempotencyKey: 'earn-1', createdBySystem: 'test' }]);
    await expect(
      post([{ type: 'reversal', party: 'driver', amount: -5000, idempotencyKey: 'rev-0', createdBySystem: 'test' }]),
    ).rejects.toBeInstanceOf(LedgerError);
    await post([
      { type: 'reversal', party: 'driver', amount: -5000, correctsEntryId: orig!._id, idempotencyKey: 'rev-1', createdBySystem: 'test' },
    ]);
    const net = (await LedgerEntryModel.find({ party: 'driver' }).lean()).reduce((a, r) => a + r.amount, 0);
    expect(net).toBe(0);
  });

  it('requires every entry to record who created it', async () => {
    await expect(post([{ type: 'adjustment', party: 'platform', amount: 1, idempotencyKey: 'x', correctsEntryId: bookingId }])).rejects.toBeInstanceOf(
      LedgerError,
    );
  });
});
