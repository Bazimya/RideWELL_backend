import type { BookingStatus } from './booking.model.js';
import { AppError } from '../../lib/errors.js';

export type ActorType = 'customer' | 'driver' | 'vehicle_partner' | 'staff' | 'system' | 'payment';

/**
 * The booking state machine (spec "Booking states"). Only the server moves a
 * booking, and only along these edges, and only for these actors. Customers and
 * partners can never reach `paid` or `completed` on their own.
 */
const TRANSITIONS: Record<string, ActorType[]> = {
  'requested->quoted': ['staff'],
  'quoted->quoted': ['staff'], // revised quote
  'quoted->paid': ['payment'],
  'quoted->expired': ['system'],
  'paid->assigned': ['driver', 'vehicle_partner'], // when every required partner has accepted
  'assigned->in_progress': ['driver'],
  'in_progress->completed': ['driver', 'staff'],
  'requested->cancelled': ['customer', 'staff'],
  'quoted->cancelled': ['customer', 'staff'],
  'paid->cancelled': ['customer', 'staff'],
  'assigned->cancelled': ['customer', 'staff'],
  'cancelled->refunded': ['staff'], // Phase 5: after the provider confirms the refund
};

export function canTransition(from: BookingStatus, to: BookingStatus, actor: ActorType): boolean {
  return (TRANSITIONS[`${from}->${to}`] ?? []).includes(actor);
}

export function assertTransition(from: BookingStatus, to: BookingStatus, actor: ActorType): void {
  if (!canTransition(from, to, actor)) {
    throw new AppError(409, 'invalid_transition', `This booking is ${from.replace('_', ' ')} and cannot be moved to ${to.replace('_', ' ')} this way.`);
  }
}

export const TERMINAL: readonly BookingStatus[] = ['completed', 'expired', 'cancelled', 'refunded'];
