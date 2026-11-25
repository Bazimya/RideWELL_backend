import { z } from 'zod';
import { BPS_TOTAL } from '../../lib/money.js';

const bps = z.number().int().min(0).max(BPS_TOTAL);

const sumsToTotal = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0) === BPS_TOTAL;

/**
 * Super Admin-editable platform configuration. Shares are basis points
 * (100 bps = 1%) so no floating point is ever involved.
 */
export const platformConfigValuesSchema = z.strictObject({
  shares: z.strictObject({
    driver_on_demand: z
      .strictObject({ platformBps: bps, driverBps: bps })
      .refine(sumsToTotal, `Driver on Demand shares must add up to ${BPS_TOTAL} bps (100%).`),
    chauffeur: z
      .strictObject({ platformBps: bps, driverBps: bps, vehicleOwnerBps: bps })
      .refine(sumsToTotal, `Chauffeur shares must add up to ${BPS_TOTAL} bps (100%).`),
  }),
  /** platform = the platform absorbs provider fees; deducted_before_split = fees come off the top. */
  providerFeeBearer: z.enum(['platform', 'deducted_before_split']),
  /**
   * Refund tiers, most generous first. A cancellation at least `minHoursBeforePickup`
   * before pickup gets `refundBps` back. Anything below the last tier gets nothing.
   */
  cancellationTiers: z
    .array(z.strictObject({ minHoursBeforePickup: z.number().int().min(0).max(24 * 30), refundBps: bps }))
    .min(1)
    .max(10)
    .refine(
      (tiers) => tiers.every((t, i) => i === 0 || (t.minHoursBeforePickup < tiers[i - 1]!.minHoursBeforePickup && t.refundBps <= tiers[i - 1]!.refundBps)),
      'Cancellation tiers must be ordered from the longest notice to the shortest, with refunds that never increase.',
    ),
  quoteValidityHours: z.number().int().min(1).max(168),
  acceptanceDeadlineMinutes: z.number().int().min(5).max(240),
  /** Pickups closer than this get a deadline of min(acceptanceDeadline, half the time left). */
  shortNoticeThresholdHours: z.number().int().min(0).max(48),
  payoutReleaseHours: z.number().int().min(0).max(24 * 60),
  schedulingBufferMinutes: z.number().int().min(0).max(240),
  tripNotStartedAlertMinutes: z.number().int().min(5).max(240),
  tripStartWindowHours: z.number().int().min(1).max(24),
  driverApproachingMeters: z.number().int().min(100).max(20_000),
  locationUpdateIntervalSeconds: z.number().int().min(5).max(120),
  locationRetentionDays: z.number().int().min(1).max(365),
  trackingWindowBeforePickupMinutes: z.number().int().min(0).max(24 * 60),
  contactHideHoursAfterTrip: z.number().int().min(0).max(24 * 7),
  /** TBD by the business: minimum booking length (hours) before a vehicle partner sees live location. null = never. */
  vehiclePartnerLiveTrackingMinHours: z.number().int().min(1).max(24 * 60).nullable(),
  insuranceExpiryWarningDays: z.number().int().min(1).max(120),
  /** Indicative prices shown on the home page before sign-up (whole RWF). null = not shown. */
  priceList: z
    .strictObject({
      airportTransferFromRwf: z.number().int().min(0).max(10_000_000).nullable(),
      driverHourlyRwf: z.number().int().min(0).max(10_000_000).nullable(),
      chauffeurHourlyFromRwf: z.number().int().min(0).max(10_000_000).nullable(),
    })
    .default({ airportTransferFromRwf: null, driverHourlyRwf: null, chauffeurHourlyFromRwf: null }),
  /** Earliest a customer may book ahead (minutes) and how far ahead (days). */
  minBookingNoticeMinutes: z.number().int().min(0).max(24 * 60).default(60),
  maxBookingAheadDays: z.number().int().min(1).max(365).default(90),
  /** Wrong trip PIN entries before the start is blocked and operations are alerted. */
  maxPinAttempts: z.number().int().min(3).max(10).default(5),
});

export type PlatformConfigValues = z.infer<typeof platformConfigValuesSchema>;

/**
 * DEVELOPMENT PLACEHOLDER VALUES. The commission split has not been decided yet.
 * A config saved with these is marked isPlaceholder=true, and production refuses
 * to send quotes while the current config is a placeholder.
 */
export const DEV_PLACEHOLDER_CONFIG: PlatformConfigValues = {
  shares: {
    driver_on_demand: { platformBps: 2500, driverBps: 7500 },
    chauffeur: { platformBps: 2000, driverBps: 3000, vehicleOwnerBps: 5000 },
  },
  providerFeeBearer: 'platform',
  cancellationTiers: [
    { minHoursBeforePickup: 24, refundBps: 10_000 },
    { minHoursBeforePickup: 2, refundBps: 5_000 },
  ],
  quoteValidityHours: 24,
  acceptanceDeadlineMinutes: 30,
  shortNoticeThresholdHours: 2,
  payoutReleaseHours: 48,
  schedulingBufferMinutes: 30,
  tripNotStartedAlertMinutes: 30,
  tripStartWindowHours: 2,
  driverApproachingMeters: 2000,
  locationUpdateIntervalSeconds: 10,
  locationRetentionDays: 30,
  trackingWindowBeforePickupMinutes: 60,
  contactHideHoursAfterTrip: 24,
  vehiclePartnerLiveTrackingMinHours: null,
  insuranceExpiryWarningDays: 30,
  priceList: { airportTransferFromRwf: 30_000, driverHourlyRwf: 8_000, chauffeurHourlyFromRwf: 15_000 },
  minBookingNoticeMinutes: 60,
  maxBookingAheadDays: 90,
  maxPinAttempts: 5,
};
