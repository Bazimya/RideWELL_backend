# RideWELL database (MongoDB)

MongoDB **must run as a replica set**: double-booking prevention and ledger postings use multi-document transactions. The API refuses to start against a standalone server.

## Collections (Phase 2)

| Collection | Purpose | Notes |
|---|---|---|
| `users` | One per person. `roles[]`: customer, driver_partner, vehicle_partner, staff, super_admin. `permissions[]` for staff. | Admin password hash, encrypted TOTP seed and hashed recovery codes are `select: false`. Admin accounts are separate from customer accounts (their own phone and email). |
| `otpStates` | Current SMS code (hashed) and attempt/lock/send counters per phone and purpose. | TTL: removed a day after last activity. |
| `sessions` | One per sign-in (refresh-token family). Only hashes of refresh tokens. | TTL: removed 30 days after expiry. |
| `auditLogs` | Write-once audit trail. | **Append-only.** Keep ≥ 2 years. |
| `ledger` | Internal accounting entries, integer RWF. | **Append-only.** Corrections are `reversal`/`adjustment` entries referencing the original. |
| `platformConfigs` | Versioned Super Admin configuration. | **Append-only.** Current = highest `version`. |
| `jobs` | Recurring job schedule and leases. | |
| `driverProfiles` | Driver partner application and status (one per user). | Embeds references, review checks, availability and status history (small, bounded, always read together). |
| `partnerProfiles` | Vehicle partner (individual or company), payout details, status. | One per user. |
| `vehicles` | Each vehicle with its own status, proposed rates, inspection, availability. | `listingType` leaves room for self-drive later. |
| `bookings` | One per booking: service, places, times, status + history, quote, commission snapshot, driver/vehicle, acceptance, encrypted trip PIN, cancellation, attention flags. | Status history embedded (bounded). |
| `payments` | Payment attempts: provider, our reference, provider reference (unique), amount from the quote, status, `isDevelopment`. | |
| `resourceLocks` | One tiny document per driver/vehicle, written inside every assignment transaction. | Makes concurrent double-booking impossible. |
| `opsAlerts` | Operations alerts (declines, timeouts, not started, PIN locked, safety, suspensions, late payments). | |
| `safetyReports` | Safety reports and their resolution. | |
| `documents` | Metadata for each uploaded file; the file lives in private storage under a random key. | Referenced, not embedded: each is reviewed, superseded and access-logged on its own. |
| `earnings` | One per partner per booking (driver, vehicle owner): amount from the quote split, status `pending → held → payable → paid` (or `disputed`, `reversed`), `releaseAt`, embedded status history. | Earnings are a working view; the ledger stays the record. A reassignment reverses the old earning and creates a new one. |
| `refunds` | Refund requests: booking, payment, amount, reason, source (`cancellation_policy` or `staff_request`), requester, approver, status (`requested`, `approved`, `completed`, `rejected`, `failed`), provider reference, `isDevelopment`. | The requester can never approve their own request. |
| `payouts` | Payouts recorded by staff after paying a partner outside the system: partner, earnings covered, amount, method, destination, the real transaction reference, idempotency key, confirmer. | One payout per transaction reference per method. |
| `locationPoints` | Raw driver positions per booking: lat, lng, accuracy, heading, speed, `recordedAt` (phone time), `receivedAt`, `source` (`driver_web` or a future `driver_app`), `purgeAt`. | **TTL on `purgeAt`**: retention days after the trip ends (30 by default); `null` while a safety report on the booking is open, so nothing is deleted until it is closed. The latest point is also copied to `bookings.tracking.lastPoint` for fast reads. |
| `notifications` | One message to one user: the in-app inbox entry (title, body, link, `readAt`) and its delivery record (channel `sms`/`email`/`none`, masked recipient, `status` `pending → sent` or `failed`/`skipped`, attempts, last error, provider and provider message id). | Sign-in codes are never stored. Secrets in a message (the trip PIN) are masked in `body` and such a message is never resent from this record (`resendable:false`). Unique `dedupeKey` per real-world event. **TTL on `expireAt`** (180 days). |
| `reviews` | Customer ratings of the driver: booking, from, to, 1–5 whole stars, optional comment (500). | One per booking per author; final once given; only within 14 days of a completed trip. Never seeded. |
| `supportRequests` | "Request support": reference `S-XXXXXX`, user, optional booking (the user must be a party to it), topic, message, status `open`/`resolved`, staff reply. | At most 5 open per person. Safety problems use `safetyReports`, which alert operations at once. |
| `trackingAccess` | Staff break-glass grants: booking, staff member, written reason, basis (`safety_report` or `trip_not_started`), expiry, last audited time. | Valid only while the emergency lasts (12 h cap). Every opening and every view (once a minute) is in the audit log. |

## Indexes

| Collection | Index | Why |
|---|---|---|
| users | `{phone:1}` unique (partial: string phones only) | SMS identity; email-only accounts have no phone |
| users | `{email:1}` unique (partial: string emails only) | admin sign-in, receipts |
| users | `{roles:1, status:1}` | admin lists, super-admin cap |
| otpStates | `{phone:1, purpose:1}` unique; `{purgeAt:1}` TTL | |
| sessions | `{userId:1, revokedAt:1}`; `{purgeAt:1}` TTL | revoke all, cleanup |
| auditLogs | `{targetType, targetId, at}`, `{actorId, at}`, `{action, at}`, `{at}` | filtered reads |
| ledger | `{idempotencyKey:1}` unique | one posting per real-world event |
| ledger | `{bookingId, createdAt}`, `{partyUserId, createdAt}`, `{type, createdAt}` | per booking / partner statements |
| platformConfigs | `{version:-1}` unique | concurrent saves cannot share a version |
| jobs | `{name:1}` unique | |
| driverProfiles / partnerProfiles | `{userId:1}` unique; `{status:1, submittedAt:1}` | one profile per role; review queue |
| vehicles | `{plate:1}` unique; `{ownerUserId:1, createdAt:-1}`; `{status:1, submittedAt:1}` | plates are unique; owner lists; queue |
| bookings | `{ref:1}` unique; `{driverId, startAt}`; `{vehicleId, startAt}`; `{status, startAt}`; `{customerId, createdAt}`; `{vehicleOwnerId, startAt}`; `{attention.needsReassignment, status}` | overlap checks, queues, lists |
| payments | `{providerRef:1}` unique; `{reference:1}` unique; `{bookingId, createdAt}`; `{status, createdAt}` | idempotent confirmation, stuck-payment re-check |
| opsAlerts | `{resolvedAt, createdAt}`, `{bookingId}` | |
| safetyReports | `{status, createdAt}`, `{bookingId}` | |
| documents | `{subjectType, subjectId, kind, status}`; `{ownerId, createdAt}`; `{kind, status, expiresAt}` | per-subject lists; expiry job |

| earnings | `{partnerUserId, status}`; `{bookingId, role, status}`; `{status, releaseAt}` | partner statements; per-booking hooks; release job |
| refunds | `{status, createdAt}`; `{bookingId}` | approval queue; booking view |
| payouts | `{idempotencyKey:1}` unique; `{method, transactionRef}` unique; `{partnerUserId, confirmedAt:-1}` | a retried or double-clicked payout is recorded once; one real transfer cannot be recorded twice |

| locationPoints | `{bookingId, recordedAt:-1}`; `{purgeAt:1}` TTL (`expireAfterSeconds: 0`) | trail per booking; retention |
| trackingAccess | `{bookingId, staffId, expiresAt:-1}` | the caller's live grant |

| notifications | `{userId, createdAt:-1}`; `{userId, readAt}`; `{status, nextAttemptAt}`; `{status, createdAt:-1}`; `{dedupeKey}` unique (partial: strings); `{expireAt}` TTL | inbox; unread count; retry job; delivery log; once per event; retention |
| reviews | `{bookingId, fromUserId}` unique; `{toUserId, createdAt:-1}`; `{createdAt:-1}` | one rating per booking; driver summary; reports |
| supportRequests | `{ref}` unique; `{userId, createdAt:-1}`; `{status, createdAt:-1}` | own list; operations queue |

`bookings.tracking` (embedded): `lastPoint`, the cached `estimate` (route or straight line, refreshed at most once a minute when it costs an API call), `approachingNotifiedAt` (the once-per-trip "driver approaching" message), `closedAt`.

Indexes are synchronised at startup (`ensureIndexes()` → `syncIndexes`, which also drops indexes no longer in the schema); `autoIndex` is off.

## Database-level protection for append-only collections (production)

The application refuses updates and deletes on `auditLogs`, `ledger` and `platformConfigs`. In production, also take the right away from the database user the API connects as, so the rule holds even if application code is bypassed:

```js
// mongosh, as a cluster admin, in the ridewell database
db.createRole({
  role: 'ridewellApp',
  privileges: [
    // normal read/write on operational collections
    { resource: { db: 'ridewell', collection: 'users' }, actions: ['find', 'insert', 'update', 'remove', 'createIndex', 'createCollection'] },
    { resource: { db: 'ridewell', collection: 'otpStates' }, actions: ['find', 'insert', 'update', 'remove', 'createIndex', 'createCollection'] },
    { resource: { db: 'ridewell', collection: 'sessions' }, actions: ['find', 'insert', 'update', 'remove', 'createIndex', 'createCollection'] },
    { resource: { db: 'ridewell', collection: 'jobs' }, actions: ['find', 'insert', 'update', 'remove', 'createIndex', 'createCollection'] },
    { resource: { db: 'ridewell', collection: 'driverProfiles' }, actions: ['find', 'insert', 'update', 'createIndex', 'createCollection', 'dropIndex'] },
    { resource: { db: 'ridewell', collection: 'partnerProfiles' }, actions: ['find', 'insert', 'update', 'createIndex', 'createCollection', 'dropIndex'] },
    { resource: { db: 'ridewell', collection: 'vehicles' }, actions: ['find', 'insert', 'update', 'createIndex', 'createCollection', 'dropIndex'] },
    { resource: { db: 'ridewell', collection: 'documents' }, actions: ['find', 'insert', 'update', 'createIndex', 'createCollection', 'dropIndex'] },
    // append-only: find + insert only
    { resource: { db: 'ridewell', collection: 'auditLogs' }, actions: ['find', 'insert', 'createIndex', 'createCollection'] },
    { resource: { db: 'ridewell', collection: 'ledger' }, actions: ['find', 'insert', 'createIndex', 'createCollection'] },
    { resource: { db: 'ridewell', collection: 'platformConfigs' }, actions: ['find', 'insert', 'createIndex', 'createCollection'] },
  ],
  roles: [],
});
db.createUser({ user: 'ridewell_api', pwd: passwordPrompt(), roles: ['ridewellApp'] });
```

Each later phase adds its collections to this role. Backups and the retention job run under separate users.

## Running a local replica set

```sh
mkdir -p ~/ridewell-db
mongod --replSet rs0 --port 27017 --bind_ip 127.0.0.1 --dbpath ~/ridewell-db
# once, in another terminal:
mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
```

## Migrations

`src/db/migrations.ts` runs at startup (idempotent). 2026-11-24: accounts with the old `ops_admin` role become `staff` with the Operations permission preset (audited as `staff.migrated_from_ops_admin`).
