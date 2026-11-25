import type { Role } from './roles.js';

/**
 * Permissions a Super Admin can tick for a staff account. Super Admins hold all of
 * them implicitly. Staff management itself (create, edit, remove staff) is NOT a
 * permission: it stays with Super Admins so nobody can grant themselves more access.
 *
 * Each later phase adds its permissions here (bookings, refunds, payouts, tracking).
 */
export const PERMISSION_CATALOG = [
  { key: 'bookings.view', group: 'Bookings', label: 'View bookings, trips and operations alerts' },
  { key: 'bookings.manage', group: 'Bookings', label: 'Create phone bookings, send quotes, assign and reassign partners, cancel and end trips' },
  { key: 'safety.handle', group: 'Bookings', label: 'Handle safety reports (resolve, release paused drivers)' },
  { key: 'tracking.emergency', group: 'Bookings', label: "Open one booking's location during an open safety report or trip-not-started alert (reason required; every access is logged)" },
  { key: 'support.handle', group: 'Bookings', label: 'Answer and close customer and partner support requests' },
  { key: 'finance.view', group: 'Finance', label: 'View payments, the ledger, partner earnings and payouts' },
  { key: 'refunds.request', group: 'Finance', label: 'Request refunds for customers' },
  { key: 'refunds.approve', group: 'Finance', label: 'Approve or reject refunds (normally super admin only; never your own requests)' },
  { key: 'payouts.confirm', group: 'Finance', label: 'Record partner payouts as paid (normally super admin only)' },
  { key: 'partners.view', group: 'Partners', label: 'View partner applications, partners and vehicles' },
  { key: 'partners.review', group: 'Partners', label: 'Review documents, record checks and inspections, approve or reject' },
  { key: 'partners.suspend', group: 'Partners', label: 'Suspend and reinstate partners and vehicles' },
  { key: 'documents.view', group: 'Partners', label: 'Open partner ID, licence and insurance documents (every view is logged)' },
  { key: 'users.view', group: 'Accounts', label: 'View customer and partner accounts' },
  { key: 'users.suspend', group: 'Accounts', label: 'Suspend and reactivate customer and partner accounts' },
  { key: 'audit.view', group: 'Oversight', label: 'Read the audit log' },
  { key: 'notifications.view', group: 'Oversight', label: 'See the SMS and email delivery log and resend failed messages' },
  { key: 'config.view', group: 'Settings', label: 'View platform settings' },
  { key: 'config.edit', group: 'Settings', label: 'Change commission, partner shares and platform rules' },
] as const;

export type Permission = (typeof PERMISSION_CATALOG)[number]['key'];
export const PERMISSIONS = PERMISSION_CATALOG.map((p) => p.key) as [Permission, ...Permission[]];

/** Quick-select sets shown in the staff form. The Super Admin can still adjust each box. */
export const PERMISSION_PRESETS: Record<string, { label: string; permissions: Permission[] }> = {
  operations: {
    label: 'Operations',
    permissions: ['bookings.view', 'bookings.manage', 'safety.handle', 'tracking.emergency', 'support.handle', 'refunds.request', 'partners.view', 'partners.review', 'partners.suspend', 'documents.view', 'users.view', 'audit.view', 'notifications.view', 'config.view'],
  },
  reviewer: { label: 'Partner reviewer', permissions: ['partners.view', 'partners.review', 'documents.view'] },
  readOnly: { label: 'Read only', permissions: ['bookings.view', 'partners.view', 'users.view', 'audit.view', 'config.view'] },
};

/** The permissions a user actually holds. */
export function effectivePermissions(user: { roles: readonly string[]; permissions?: readonly string[] | null }): Permission[] {
  if (user.roles.includes('super_admin' satisfies Role)) return [...PERMISSIONS];
  if (!user.roles.includes('staff' satisfies Role)) return [];
  const valid = new Set<string>(PERMISSIONS);
  return (user.permissions ?? []).filter((p): p is Permission => valid.has(p));
}
