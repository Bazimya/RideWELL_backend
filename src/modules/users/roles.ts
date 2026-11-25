/**
 * Account types.
 *  - customer: books trips.
 *  - driver_partner: "Driver / Chauffeur" in the UI. Approved separately.
 *  - vehicle_partner: supplies vehicles for chauffeur trips. Approved separately.
 *  - staff: RideWELL team member created by a Super Admin, with ticked permissions.
 *  - super_admin: founders (max 2). Every permission, plus staff management.
 */
export const ROLES = ['customer', 'driver_partner', 'vehicle_partner', 'staff', 'super_admin'] as const;
export type Role = (typeof ROLES)[number];

export const ADMIN_ROLES: readonly Role[] = ['staff', 'super_admin'];
export const PARTNER_ROLES: readonly Role[] = ['driver_partner', 'vehicle_partner'];

/** The spec caps super admins at two people (the founders). */
export const MAX_SUPER_ADMINS = 2;

export const isAdminRole = (r: Role) => ADMIN_ROLES.includes(r);
export const hasAdminRole = (roles: readonly Role[]) => roles.some(isAdminRole);
