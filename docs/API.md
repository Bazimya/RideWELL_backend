# RideWELL API — v1 (Phase 2: foundation)

Base path: `/api/v1`. JSON in and out. All amounts are whole RWF integers.

## Conventions

| Topic | Rule |
|---|---|
| Authentication | `Authorization: Bearer <accessToken>` (15-minute JWT). Never in a cookie or query string. |
| Refresh | `rw_rt` cookie: `httpOnly`, `Secure` (production), `SameSite=Strict`, `Path=/api/v1/auth`. Rotated on every use; replaying an old one ends the whole session. |
| Cookie routes | `/auth/refresh`, `/auth/logout`, `/auth/logout-all` also require header `X-RideWELL-Client: web` (CSRF defence). |
| Step-up | Marked **step-up** below: also send `X-2FA-Code: <current authenticator code>`. Each code works once. |
| Validation | Unknown fields are rejected (`400 validation_failed`), never ignored. Keys starting with `$` or containing `.` are rejected (`400 invalid_input`). |
| Errors | `{"error": {"code", "message", "details?", "requestId"}}`. No stack traces. `429` responses carry `Retry-After`. |
| Pagination | Newest first; pass `before=<id>` from `nextBefore` for the next page. |

## Health

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health` | none | `{status:"ok"}` (process is up) |
| GET | `/ready` | none | `200 {status:"ready"}` or `503` (database connected) |

## Customer and partner sign-in (phone + SMS code)

| Method | Path | Body | Response | Notes |
|---|---|---|---|---|
| POST | `/auth/otp/request` | `{phone}` | `202 {status:"sent", expiresInSeconds:600}` | Same answer for any phone. Not sent to admin accounts. 60 s resend cooldown, 5 codes/hour per phone, 10 requests/15 min per IP. |
| POST | `/auth/otp/verify` | `{phone, code}` | `200 {accessToken, isNewUser, user}` + `rw_rt` cookie | Creates the customer account on first success. 5 wrong attempts → phone locked 15 min (`429`). `403 account_suspended`. |

`phone` accepts `0788123456`, `+250 788 123 456` or international numbers; stored as E.164.

## Sessions

| Method | Path | Auth | Response |
|---|---|---|---|
| POST | `/auth/refresh` | `rw_rt` cookie + client header | `200 {accessToken, user}` + new cookie; `401` if ended |
| POST | `/auth/logout` | bearer + client header | `204` (this session) |
| POST | `/auth/logout-all` | bearer + client header | `204` (every session of the user; audited) |

Session lifetime: customers/partners 30 days, admins 8 hours (absolute; refresh never extends it).

## Admin sign-in and setup (password + authenticator app)

| Method | Path | Body | Response | Notes |
|---|---|---|---|---|
| POST | `/auth/admin/invite/accept` | `{token, password}` | `{otpauthUri, secret}` | Token from the invite link fragment. Password ≥ 10 chars, not common, not containing name/email/phone. |
| POST | `/auth/admin/invite/confirm` | `{token, code}` | `{recoveryCodes: string[10]}` | Activates the account. Codes shown once. |
| POST | `/auth/admin/login` | `{email, password}` | `{mfaToken}` (5 min) | Same `401 invalid_credentials` for unknown email, wrong password, or locked account. 5 failures → 15-min lock. |
| POST | `/auth/admin/login/mfa` | `{mfaToken, code}` or `{mfaToken, recoveryCode}` | `{accessToken, user, sessionExpiresAt}` + cookie | Wrong codes count towards the lock. New devices are audit-logged. |
| POST | `/auth/admin/password-reset/request` | `{email}` | `202` | SMS code (30 min) to the admin's phone. Same answer for any email. |
| POST | `/auth/admin/password-reset/confirm` | `{email, code, totpCode, newPassword}` | `204` | Needs both the SMS code and an authenticator code. Ends every session. |

The first super admin is created on the server: `npm run create-super-admin -- --phone … --email … --first … --last …`.

## My account

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/me` | any signed-in user | — | `{user, sessionKind}` |
| PATCH | `/me` | any signed-in user | `{firstName?, lastName?, email?\|null}` | `{user}`. Roles and status cannot be sent. Admins cannot change their email here. `409 email_taken`. |

## Admin

All routes require an **admin session** (password + authenticator). Customer/partner sessions get `403`; an admin account used through a non-admin session gets `401`.

| Method | Path | Roles | Body / query | Response |
|---|---|---|---|---|
| GET | `/admin/users` | ops, super | `?role&status&phone&limit&before` | `{users, nextBefore}` |
| POST | `/admin/users/:id/suspend` | super | `{reason}` | `204`; ends the user's sessions; audited |
| POST | `/admin/users/:id/reactivate` | super | `{reason}` | `204`; audited |
| GET | `/admin/admins` | super | — | `{admins}` |
| POST | `/admin/admins` | super, **step-up** | `{phone, email, firstName, lastName, role}` | `201 {id, inviteUrl, inviteExpiresInHours}`; invite also emailed. Max 2 super admins. |
| DELETE | `/admin/admins/:id` | super, **step-up** | `{reason}` | `204`; strips admin roles, suspends, ends sessions. Cannot remove yourself or the last super admin. |
| GET | `/admin/audit-logs` | ops, super | `?targetType&targetId&actorId&action&limit&before` | `{entries, nextBefore}`. **Read only: no route can change or delete an entry.** |
| GET | `/admin/config` | ops, super | — | `{config: {version, values, isPlaceholder, createdAt} \| null}` |
| PUT | `/admin/config` | super, **step-up** | `{values, note?}` | `{config}`: a new version (old versions are kept); audited with before/after. |

### Platform config `values`

Shares are **basis points** (100 bps = 1 %) and must add up to 10 000 per service.

```json
{
  "shares": {
    "driver_on_demand": { "platformBps": 2500, "driverBps": 7500 },
    "chauffeur": { "platformBps": 2000, "driverBps": 3000, "vehicleOwnerBps": 5000 }
  },
  "providerFeeBearer": "platform | deducted_before_split",
  "cancellationTiers": [{ "minHoursBeforePickup": 24, "refundBps": 10000 }, { "minHoursBeforePickup": 2, "refundBps": 5000 }],
  "quoteValidityHours": 24,
  "acceptanceDeadlineMinutes": 30,
  "shortNoticeThresholdHours": 2,
  "payoutReleaseHours": 48,
  "schedulingBufferMinutes": 30,
  "tripNotStartedAlertMinutes": 30,
  "tripStartWindowHours": 2,
  "driverApproachingMeters": 2000,
  "locationUpdateIntervalSeconds": 10,
  "locationRetentionDays": 30,
  "trackingWindowBeforePickupMinutes": 60,
  "contactHideHoursAfterTrip": 24,
  "vehiclePartnerLiveTrackingMinHours": null,
  "insuranceExpiryWarningDays": 30
}
```

The values above are the **development placeholders** (`npm run seed:dev`, `isPlaceholder: true`). In production, anything that sets a price or split refuses to run until a Super Admin saves real values.

---

# Phase 3 additions

## Email + password (customers and partners)

| Method | Path | Body | Response | Notes |
|---|---|---|---|---|
| POST | `/auth/email/register` | `{email, password, firstName, lastName}` | `201 {accessToken, user}` + cookie | **Temporary:** no email verification yet (`EMAIL_SIGNUP_WITHOUT_VERIFICATION`, refused in production). `409 email_taken`. |
| POST | `/auth/email/login` | `{email, password}` | `{accessToken, user}` + cookie | Same `401` for unknown email, wrong password, locked account and admin accounts. 5 failures → 15-min lock. `403 account_suspended`. |
| PUT | `/me/password` | `{currentPassword?, newPassword}` | `204` | Sets a first password (needs an email on the account) or changes it (needs the current one). Signs out other sessions. Not for admins. |

`user` now includes `emailVerified` and `hasPassword`; `phone` may be `null` for email-only accounts.

## Partner self-service (`/partners`, customer/partner sessions only; admins get 403)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/partners/driver` | — | Creates a draft driver profile on first call. Returns `{profile, documents, submissionRequirements}`. |
| PUT | `/partners/driver` | `{contactPhone?, licenceNumber?, licenceExpiry?, licenceCategories?, experienceYears?, areas?, languages?, bio?, references?}` | Only while `draft` or `rejected` (409 otherwise). |
| POST | `/partners/driver/documents` | multipart `kind` + `file` | Kinds: `id_document`, `driving_licence`, `profile_photo` (photo only), `good_conduct_certificate`, `other`. |
| POST | `/partners/driver/submit` | — | `400 incomplete_application` with the unmet items in `details`. Sends "application received". |
| PUT | `/partners/driver/availability` | `{acceptingTrips, unavailable: [{from, to, note?}]}` | Approved drivers only. |
| GET / PUT | `/partners/owner` | `{contactPhone?, type?, companyName?, rdbNumber?, tinNumber?, representativeName?, payout?}` | `payout` is `{method:'momo', momoPhone, momoName}` or `{method:'bank', bankName, accountName, accountNumber}`. Returns profile, documents, requirements and the owner's vehicles. |
| POST | `/partners/owner/documents` | multipart | Kinds: `id_document`, `rdb_certificate`, `authorisation_letter`, `other`. |
| POST | `/partners/owner/submit` | — | |
| POST | `/partners/vehicles` | `{make, model, year, plate, colour, category, seats, insurer?, insurancePolicyNumber?, insuranceExpiry?, proposedRates?}` | Plate normalised (`rab 123-c` → `RAB123C`), unique: `409 plate_taken`. Rates are whole RWF. |
| GET / PUT | `/partners/vehicles/:id` | same fields, partial | Own vehicles only (404 otherwise). Editable while `draft`/`rejected`. |
| POST | `/partners/vehicles/:id/documents` | multipart | Kinds: `registration_certificate`, `ownership_proof`, `insurance`, `vehicle_photo` (photos, up to 8), `other`. |
| POST | `/partners/vehicles/:id/submit` | — | Owner application must be submitted; 4+ photos. |
| PUT | `/partners/vehicles/:id/availability` | as for drivers | Approved vehicles only. |
| DELETE | `/partners/documents/:id` | — | Withdraw your own pending/rejected file. |

**When uploads are allowed:** draft/rejected: any kind. Applied/under review: only to replace a rejected file. Approved: renewals only (`driving_licence`, `insurance`, `profile_photo`); the approved file stays in force until the new one is approved. Suspended: none.

**Upload rules:** JPG, PNG or PDF by content (not extension); max 5 MB; images are re-encoded, which strips EXIF/GPS; PDFs with JavaScript, launch actions, embedded files or encryption are refused; random storage keys; private storage only.

## Documents (`/documents`, owner or admin)

| Method | Path | Response | Notes |
|---|---|---|---|
| POST | `/documents/:id/link` | `{url, expiresAt}` | 5-minute link bound to the caller's session. Others' documents → 404. |
| GET | `/documents/:id/content?exp&sig` | the file | Also needs the bearer token of the **same** session. Expired → 410, other session or tampered → 403, signed out → 401. Every view is audit-logged (`document.viewed_by_admin` / `_by_owner`). Sent with `Content-Security-Policy: sandbox`, `nosniff`, `no-store`. |

## Partner review (`/admin/partners`, Ops Admin and Super Admin)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/admin/partners/applications?kind=driver\|owner\|vehicle&status=applied,under_review` | — | Queue, oldest submission first. |
| GET | `/admin/partners/:kind/:id` | — | Details, applicant contact, documents, approval requirements, live eligibility. |
| POST | `/admin/partners/:kind/:id/start-review` | — | applied → under_review. |
| POST | `/admin/partners/documents/:id/review` | `{decision: approved\|rejected, note?, expiresAt?}` | Rejection needs a note. Licence and insurance approvals need a future `expiresAt`. |
| POST | `/admin/partners/driver/:id/checks` | `{check: interview\|drivingTest\|references, result: passed\|failed, notes?}` | Under review only. |
| POST | `/admin/partners/vehicle/:id/inspection` | `{result, notes?}` | Under review only. |
| POST | `/admin/partners/:kind/:id/decision` | `{decision: approve\|reject, reason?}` | Approve refused (`requirements_not_met`) until every requirement is met; vehicles need an approved owner. Approval grants `driver_partner` / `vehicle_partner`. Reject needs a reason, sent to the partner. |
| POST | `/admin/partners/:kind/:id/suspend` / `reinstate` | `{reason}` | Suspending a driver or owner ends their sessions immediately. |

## Background job

`documents.expiry` (hourly): warns once N days before a licence or insurance expires (`insuranceExpiryWarningDays`, default 30) and notifies once when it has expired. Assignment eligibility checks expiry live, so an expired document blocks trips even if the job has not run.

---

# Staff accounts and permissions (replaces "ops admin" and admin invites)

Account types: `customer`, `driver_partner` ("Driver / Chauffeur" in the UI), `vehicle_partner`, `staff`, `super_admin` (max 2).
Staff accounts are created by a Super Admin, who sets the password and ticks permissions. Super Admins hold every permission. Staff management itself is Super Admin only and is not a grantable permission.

## Permissions

| Key | Allows |
|---|---|
| `partners.view` | View partner applications, partners and vehicles |
| `partners.review` | Review documents, record checks/inspections, approve or reject |
| `partners.suspend` | Suspend and reinstate partners and vehicles |
| `documents.view` | Open partner ID, licence and insurance documents (every view logged) |
| `users.view` | View customer and partner accounts |
| `users.suspend` | Suspend and reactivate customer and partner accounts |
| `audit.view` | Read the audit log |
| `config.view` | View platform settings |
| `config.edit` | Change commission, partner shares and platform rules (also needs a fresh authenticator code) |

Presets (quick select in the UI): Operations, Partner reviewer, Read only. `GET /admin/permissions` returns the catalogue and presets.
Permissions are read from the database on every request, so a change applies on the staff member's next request. `user.permissions` in `/me` and sign-in responses lists the effective set.

## Staff sign-in

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/auth/admin/login` | `{email, password}` | `{mfaToken, setupRequired}` |
| POST | `/auth/admin/2fa/setup` | `{mfaToken}` | `{otpauthUri, secret}`: first sign-in only |
| POST | `/auth/admin/2fa/confirm` | `{mfaToken, code}` | `{accessToken, user, sessionExpiresAt, recoveryCodes}` + cookie; enables 2FA |
| POST | `/auth/admin/login/mfa` | `{mfaToken, code \| recoveryCode}` | `{accessToken, user, sessionExpiresAt}`; `409 two_factor_setup_required` if 2FA is not set up yet |

The invite endpoints (`/auth/admin/invite/*`) were removed.

## Staff management (Super Admin only; all writes need `X-2FA-Code`)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/admin/staff` | — | Staff and super admins with effective permissions and 2FA state |
| POST | `/admin/staff` | `{email, phone?, firstName, lastName, password, accountType: staff\|super_admin, permissions[]}` | Password policy applies. Max 2 super admins. Email/phone must not belong to another account. |
| PUT | `/admin/staff/:id` | `{firstName?, lastName?, phone?, permissions?}` | Audited before/after |
| POST | `/admin/staff/:id/password` | `{password}` | Ends all their sessions |
| POST | `/admin/staff/:id/reset-2fa` | — | Lost phone: ends sessions; they set up 2FA again at next sign-in |
| DELETE | `/admin/staff/:id` | `{reason}` | Strips admin roles, suspends, ends sessions. Not yourself; not the last super admin. |

Route permissions: `/admin/users` → `users.view`; suspend/reactivate → `users.suspend`; `/admin/audit-logs` → `audit.view`; `GET /admin/config` → `config.view`; `PUT /admin/config` → `config.edit`; partner review routes → `partners.view` / `partners.review` / `partners.suspend`; document links for admins → `documents.view`.

## Development verification code

With `DEV_VERIFICATION_CODE=123456` (development only; production refuses to start with it), that code is accepted wherever a verification code is asked for:

- SMS codes (phone sign-in, staff password reset): every code sent is that code; expiry, single use, attempt limits and lockouts still apply.
- Staff sign-in code step: accepted instead of an authenticator code, and authenticator setup at first sign-in is skipped (`setupRequired: false`).
- Step-up confirmations (`X-2FA-Code`) and the authenticator code in the staff password reset.

`POST /auth/otp/request`, `POST /auth/admin/login` and `POST /auth/admin/password-reset/request` return it as `developmentCode` so the screens can show and pre-fill it. Real authenticator codes keep working alongside it. Sign-ins that used it are audit-logged with `usedDevelopmentCode: true`.

---

# Phase 4: bookings and operations

States (server-only): `requested → quoted → paid → assigned → in_progress → completed`, plus `expired`, `cancelled`, `refunded`. Every move records status history and an audit entry. Times are stored in UTC and shown in Africa/Kigali.

## Public
| Method | Path | Response |
|---|---|---|
| GET | `/public/prices` | `{prices: {airportTransferFromRwf, driverHourlyRwf, chauffeurHourlyFromRwf}, isPlaceholder, currency}` (indicative, from platform config) |

## Customers (`/bookings`, customer sessions)
| Method | Path | Body / notes |
|---|---|---|
| POST | `/bookings` | `{service: driver_on_demand\|chauffeur, airport?: {direction, flightNumber?}, pickup: {address, lat?, lng?, notes?}, dropoff?, startAt, durationHours (1–336), passengers, notes?, customerVehicle? (Driver on Demand: make, model, plate, colour?, transmission?)}`. At least `minBookingNoticeMinutes` (60) ahead, at most `maxBookingAheadDays` (90). Unknown fields such as `status` or `quote` are refused. |
| GET | `/bookings` | Own bookings |
| GET | `/bookings/:id` | Own booking: quote, payment, driver first name + photo flag, vehicle (make, model, colour, plate) and trip PIN once assigned (PIN hidden after start), cancellation preview, safety-report availability |
| POST | `/bookings/:id/pay` | No body is used: the server charges the stored quote. Development provider settles immediately. `409 quote_expired` / `not_payable`. |
| POST | `/bookings/:id/cancel` | `{reason?}`. Paid/assigned bookings get the refund the snapshotted policy gives (recorded as `refundDueRwf`; processed in Phase 5). |
| POST | `/bookings/:id/safety-report` | `{message}`. Active trips and up to 24 h after. Alerts operations by SMS and email; pauses the driver. |
| GET | `/bookings/:id/driver-photo` | The assigned driver's approved photo (this booking's customer only) |

## Drivers (`/driver/trips`, role `driver_partner`) and vehicle owners (`/owner/trips`, role `vehicle_partner`)
| Method | Path | Notes |
|---|---|---|
| GET | `/driver/trips`, `/driver/trips/:id` | Offers, upcoming and trips completed in the last 24 h. Customer phone only while assigned/in progress. Google Maps navigation links. |
| POST | `/driver/trips/:id/accept` / `decline` | Before the acceptance deadline. Re-checks the driver is still eligible. Decline `{reason?}` alerts operations. |
| POST | `/driver/trips/:id/start` | `{pin}` (4 digits). From `tripStartWindowHours` (2) before pickup. 5 wrong PINs → `423 pin_locked` + high-priority alert. |
| POST | `/driver/trips/:id/complete` | In-progress trips only |
| POST | `/driver/trips/:id/safety-report` | `{message}` |
| GET | `/owner/trips` | Bookings with the owner's vehicles: status and times, no customer details or addresses |
| POST | `/owner/trips/:id/accept` / `decline` | |

## Staff (`/admin`, admin sessions)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/admin/bookings?status=&attention=true` | `bookings.view` | |
| POST | `/admin/bookings` | `bookings.manage` | Phone booking: the booking body plus `customerPhone`, `customerFirstName?` (account found or created) |
| GET | `/admin/bookings/:id` | `bookings.view` | Everything, incl. customer contact, split snapshot, acceptance, payments, history |
| GET | `/admin/bookings/:id/candidates?durationHours=` | `bookings.manage` | Every approved driver and vehicle with `available` and the reasons when not (booked at this time incl. 30-min buffer, marked unavailable, not accepting trips, licence/insurance expiring before trip end, seats, safety pause) |
| POST | `/admin/bookings/:id/quote` | `bookings.manage` | `{amountRwf, driverId, vehicleId? (chauffeur), durationHours?, note?}`. Locks the driver/vehicle and re-checks overlap inside a transaction. Snapshots shares and the integer split (remainder to platform). Valid for `quoteValidityHours` (24) or until pickup. |
| POST | `/admin/bookings/:id/assign` | `bookings.manage` | Reassign driver and/or vehicle (quoted, paid or assigned), same checks; a new acceptance deadline |
| POST | `/admin/bookings/:id/cancel` | `bookings.manage` | `{reason, refundMode: policy\|full}` |
| POST | `/admin/bookings/:id/complete` | `bookings.manage` | `{reason}`: end a trip for the driver |
| GET | `/admin/alerts` | `bookings.view` or `safety.handle` | Open operations alerts |
| POST | `/admin/alerts/:id/resolve` | `bookings.manage` or `safety.handle` | `{resolution}` |
| GET | `/admin/safety-reports?status=open\|resolved` | `safety.handle` | |
| POST | `/admin/safety-reports/:id/resolve` | `safety.handle` | `{resolution, releaseDriver}` |

## Jobs (every minute, single-instance by lease)
`bookings.expire-quotes` (unpaid quotes past validity → expired), `bookings.acceptance-timeouts` (alert once per offer), `bookings.not-started-alerts` (assigned and 30 min past pickup → high alert, once).

## Payments (development stand-in)
`PAYMENT_PROVIDER=dev` (refused in production) implements the payment-provider interface without moving money. Payments are stored with `isDevelopment: true`. Confirmation re-asks the provider, requires the exact quoted amount, is idempotent by provider reference (unique index), and only then moves the booking `quoted → paid`. A payment confirmed after the booking stopped accepting it raises a high alert for a refund. A real provider (Paypack) replaces the stand-in when payments are taken up again; it was deliberately not integrated in Phase 5.


# Phase 5: earnings, refunds and payouts

All amounts are integer RWF. Every money event is a ledger posting with an idempotency key, inside the same transaction as the state change it records. For every booking: customer payments − refunds = the sum of allocations (platform commission, driver earning, vehicle owner earning, provider fee, adjustments and reversals). Payouts settle allocations; they are not allocations.

## What happens automatically
| Event | Ledger | Earnings |
|---|---|---|
| Payment confirmed | `customer_payment`, `provider_fee` (if any, absorbed by the platform), `platform_commission`, one earning entry per partner | `pending` |
| Driver or vehicle reassigned or declines, partner suspended | `reversal` of the old earning entry, new entry for the new partner | old `reversed`, new `pending` |
| Trip started | | `held` |
| Trip completed | | `held` with `releaseAt` = end + `payoutReleaseHours` (config) |
| Safety report opened / resolved | | `disputed` / back to `held` |
| Release job, after `releaseAt`, trip completed, no open report | | `payable` |
| Paid booking cancelled | `reversal` of the commission and every unpaid earning, policy-retained amount kept as platform income | `reversed`; a refund request for what the policy returns |

## Staff (`/admin/finance`, admin sessions)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/summary` | `finance.view` | Totals: customer payments, refunds, provider fees, platform net, paid out, open refunds, count of development payments |
| GET | `/ledger?bookingId=&type=&limit=` | `finance.view` | Newest first |
| GET | `/bookings/:id` | `finance.view`, `refunds.request` or `refunds.approve` | `{balance: {paid, refunded, allocations, paidOut, balanced}, entries, earnings, refunds}` |
| GET | `/refunds?status=` | `finance.view`, `refunds.request` or `refunds.approve` | Default `requested` |
| POST | `/refunds` | `refunds.request` | `{bookingId, amountRwf, reason}`. At most what was paid minus refunds already requested or done. |
| POST | `/refunds/:id/approve` | `refunds.approve` + `X-2FA-Code` | `{note?}`. Never by the requester. Sends the refund through the payment provider; ledger `refund` only after the provider confirms. Policy refunds are funded by the reversals already posted; goodwill refunds post a platform `adjustment`. Provider refusal → `failed` (502). |
| POST | `/refunds/:id/reject` | `refunds.approve` + `X-2FA-Code` | `{note}` (required) |
| GET | `/payables` | `payouts.confirm` or `finance.view` | Payable earnings grouped by partner, with the partner's payout details |
| GET | `/payouts` | `finance.view` or `payouts.confirm` | |
| POST | `/payouts` | `payouts.confirm` + `X-2FA-Code` | `{partnerUserId, earningIds[], amountRwf, method: momo\|bank, destination, transactionRef, idempotencyKey}`. Records a transfer made outside the system: the amount must equal the selected payable earnings, which must all belong to the partner. Ledger `payout` per earning; earnings `paid`. Same key returns the same payout; a reused transaction reference is refused. |

## Partners
| Method | Path | Notes |
|---|---|---|
| GET | `/partners/earnings` | Own earnings with totals by status, and own payouts. Read only. |
| PUT | `/partners/payout-details` | `{role: driver\|owner, payout: {method: momo, momoPhone, momoName} \| {method: bank, bankName, accountName, accountNumber}}` |

## Customers
`GET /bookings/:id` now includes `refunds: [{amountRwf, status: requested|completed|rejected|failed, completedAt, isDevelopment}]`.

## Jobs (every 5 minutes)
`finance.release-earnings` (held → payable when due), `payments.recheck-pending` (payments pending more than 15 minutes are re-asked from the provider and confirmed or failed).

## Development only
`npm run dev:release-earnings -- --hours 48` runs the real release job as if that many hours had passed, to test payouts without waiting out the hold. It refuses to run in production and never edits an earning directly.


# Phase 6: maps and live tracking

Approved provider: **Google Maps Platform**. Until keys are added, `MAPS_PROVIDER=dev` (refused in production): no place results or travel times are invented; distance is a straight line and labelled as such.

## Maps (`/maps`, open to signed-out visitors for the booking form, rate-limited: 150 per 15 min per IP)
| Method | Path | Notes |
|---|---|---|
| GET | `/maps/config` | `{provider, search, browserKey}`. `browserKey` is the Maps JavaScript API key only (restrict it to RideWELL domains); the server key never leaves the server. |
| GET | `/maps/autocomplete?q=&session=` | Places API (New), Rwanda only, biased to Kigali, billed per session token. Dev: `{available:false, suggestions:[]}` |
| GET | `/maps/place/:placeId?session=` | `{place: {placeId, address, lat, lng}}`. Dev: 404 |
| GET | `/maps/reverse?lat=&lng=` | `{address}` (Geocoding API). Dev: `null`. Coordinates are not stored or logged. |

Bookings accept `pickup.lat/lng` and `dropoff.lat/lng` (already in the schema). Navigation links use coordinates when present.

## Tracking (REST; the same payload serves a future native driver app)
| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/driver/trips/:id/location` | the booking's driver | `{lat, lng, accuracyM, recordedAt, headingDeg?, speedMps?, source?}`. Only inside the tracking window; `409 tracking_not_open` / `tracking_closed`; `recordedAt` not in the future and at most 10 min old. Points closer than half the interval apart are acknowledged (`accepted:false, reason:'too_soon'`) and not stored. Rate-limited (400 per 15 min). |
| GET | `/driver/trips/:id/tracking` | the booking's driver | Window state and own last point |
| GET | `/bookings/:id/tracking` | the booking's customer | `{state: not_yet\|open\|closed, opensAt, driverLocation: {lat,lng,accuracyM,recordedAt,receivedAt}, pickup, dropoff, estimate: {to, distanceM, durationS, kind: route\|straight_line}, updateIntervalSeconds, provider}`. Location only while `open`. |
| GET | `/owner/trips/:id/tracking` | the vehicle's owner | Only for hires at least `vehiclePartnerLiveTrackingMinHours` long (config, **TBD**, off by default), only while in progress. Never the customer's addresses. |
| GET | `/admin/bookings/:id/tracking` | `tracking.emergency` | `{eligible, basis, access}`. `access` only with a live grant while the booking has an open safety report or an open trip-not-started alert: last point, pickup, drop-off, last 30 points. Each view is audited (once a minute per grant). |
| POST | `/admin/bookings/:id/tracking-access` | `tracking.emergency` | `{reason}` (10+ characters). `409 no_emergency` otherwise. Audited with the reason. Ends when the emergency ends (or after 12 h). |

**Tracking window**: from `trackingWindowBeforePickupMinutes` (60) before pickup, once the booking is `assigned`, until the trip ends or is cancelled. Sharing closes on end or cancellation. A reassigned booking starts with a clean tracking state.

**Driver approaching**: once per trip, when a point is within `driverApproachingMeters` (2,000) of a pickup with coordinates, the customer gets `trip.approaching` (SMS or email). Computed on the server with plain distance maths (no API cost).

**ETA**: from the Routes API (traffic-aware), cached per trip for 60 s, so not every 10-second update costs a call. A failed route falls back to a labelled straight line.

## WebSocket `GET /api/v1/tracking/ws`
Browsers must come from an allowed origin (`CORS_ORIGINS`). Messages are JSON:
1. client `{type:'auth', token}` within 5 s (customer or partner access token; staff sessions are refused), server `{type:'ready'}`;
2. client `{type:'subscribe', bookingId, as: customer|driver|owner}`;
3. server `{type:'update', view}` (same view as REST) on subscribe, on each new point, and every minute; closes with 1000 when tracking ends.

Errors: `{type:'error', code}` then close 4401 (unauthenticated), 4403/4404 (not allowed or not found), 4400 (bad message). The session and access are re-checked before every push. Single API instance: fan-out is in-process; use Redis pub/sub before running more than one.

## Permissions
New: `tracking.emergency` (in the Operations preset).

# Phase 7: dashboards and notifications

## Notifications
Providers (chosen 2026-11-25): **Pindo** for SMS (`SMS_PROVIDER=pindo`, `PINDO_API_TOKEN`, `PINDO_SENDER_ID`) and **Resend** for email (`EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`, optional `EMAIL_REPLY_TO`). Until keys are added both stay on `outbox` (refused in production). Both adapters are built to the providers' documented request and response formats and **have not been run against the live services**.

Every user notification is stored (`notifications`), shown in the app, and delivered by SMS when the account has a phone, otherwise by email. A retryable failure (network, timeout, 429, 5xx, Resend `concurrent_idempotent_requests`) is retried after 1, 5 and 30 minutes, then marked `failed`; a permanent one (bad key, refused number, unverified domain) fails at once. Emails carry `Idempotency-Key: notification/<id>`, so a retry never sends twice. Sign-in codes and staff alerts are sent directly and not stored.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/me/notifications?before=&limit=` | any signed-in account | Own inbox only: `{notifications:[{id,key,title,body,link,createdAt,readAt}], unread, nextBefore}` |
| POST | `/me/notifications/read` | any signed-in account | `{ids?}`; all unread when omitted. Other people's ids are ignored. `204` |
| GET | `/admin/notifications?status=&userId=&before=` | `notifications.view` | Delivery log: `{providers, last7Days, notifications:[…masked recipient, status, attempts, lastError, provider, providerMessageId, resendable]}` |
| POST | `/admin/notifications/:id/resend` | `notifications.view` | Failed messages only; `409 not_resendable` when the message held a secret. Audited. |

## Ratings
| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/bookings/:id/rating` | the booking's customer | `{stars: 1–5 integer, comment?}`. Completed trips only, within 14 days, once (`409 already_rated`). 2★ or less raises an ops alert (`low_rating`). Returns the customer booking view (now with `rating`, `canRate`). |
| GET | `/driver/ratings` | `driver_partner` | `{count, average, distribution, recent:[{stars, comment, createdAt}]}`; no customer names or booking references |

Staff booking views include `rating`.

## Support
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/support` | customers and partners (not staff) | Own requests with replies |
| POST | `/support` | customers and partners | `{category: booking\|payment\|account\|partner\|other, message, bookingId?}`; the caller must be the booking's customer, driver or vehicle owner. At most 5 open (`409 too_many_open`). Notifies `support.received`. |
| GET | `/admin/support?status=open\|resolved` | `support.handle` | Queue with the requester's name and contact |
| POST | `/admin/support/:id/resolve` | `support.handle` | `{reply}`; notifies `support.answered`. Audited. |

## Dashboards and reports (all computed live from the records; nothing cached or estimated)
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/me/dashboard` | customer/partner sessions | `customer` (upcoming, next steps `pay_quote`/`rate_driver`, totals, open support), plus `driver` and `owner` sections for those roles (offers awaiting an answer, next trip, counts, earnings totals, rating, expiring documents) |
| GET | `/admin/dashboard` | any staff | Sections by permission: `bookings` (`bookings.view`), `safety` (`safety.handle`), `support` (`support.handle`), `partners` (`partners.view`), `finance` (any finance permission), `notifications` (`notifications.view`) |
| GET | `/admin/reports/operations?from=&to=` | `bookings.view` | Kigali dates `YYYY-MM-DD`, default last 30 days, max 366. Requests by service/channel/status, funnel, median time to quote and to confirmed driver, cancellations by actor, completed trips and hours, alerts, safety reports, ratings, per-driver table, daily series |
| GET | `/admin/reports/finance?from=&to=[&format=csv]` | `finance.view` | From the ledger, split into `real` and `development` (money from development payments, which moved none), by service, daily series, amounts owed to partners now. `format=csv`: one row per ledger entry with a development flag; formula-like cells are neutralised; each export is audited (`finance.exported`) |

## Permissions
New: `support.handle` and `notifications.view` (both in the Operations preset).

## Jobs
`notifications.retry` every minute.
