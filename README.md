# RideWELL backend

API for RideWELL, a centrally managed mobility service in Kigali (Driver on Demand, Chauffeur / Airport transfer).

Stack: Node 22, Express 5, TypeScript, MongoDB (replica set) via Mongoose, Zod validation.

## Run locally

```sh
npm install
cp .env.example .env        # fill in the secrets (commands are in the file)
# start a MongoDB replica set: see docs/DATABASE.md
npm run seed:dev            # DEV PLACEHOLDER platform config (refuses in production)
npm run seed:dev-accounts   # DEV ONLY: creates the accounts whose credentials are in .env (DEV_*)
npm run seed:demo           # DEV ONLY: demo customers, drivers, owners and cars, all labelled [DEMO] (add -- --reset to rebuild)
npm run create-super-admin -- --email you@example.com --first Jane --last Doe [--password '...']   # founders; 2FA set up at first sign-in
npm run dev                 # http://localhost:4000
```

No SMS or email provider is chosen yet. In development, messages (including sign-in codes) are written to `var/outbox/sms.jsonl` and `var/outbox/email.jsonl`. Production refuses to start with this adapter.

## Test

```sh
npm test          # 122 integration tests against an in-memory MongoDB replica set
npm run typecheck
```

End-to-end browser tests live in the frontend repo (`npm run test:e2e`).

## Layout

```
src/
  config/env.ts            all configuration, validated; production safety checks
  db/                      connection, transactions, append-only guard
  lib/                     errors, validation, crypto, money (integer RWF), phone, logging
  middleware/              authentication, role checks, step-up 2FA, rate limits
  modules/
    auth/                  SMS OTP, admin password + TOTP, sessions, refresh rotation
    users/                 user model, roles, /me
    admin/                 admin routes (users, admins, audit log, config)
    partners/              driver/owner applications, vehicles, review, eligibility, expiry job
    documents/             upload inspection/cleaning, private document access
    storage/               private storage (encrypted local for dev, S3-compatible)
    audit/                 write-once audit log
    ledger/                append-only accounting ledger
    platformConfig/        versioned Super Admin configuration
    notifications/         SMS/email adapters + message catalog
    jobs/                  MongoDB-leased recurring jobs
  scripts/                 create-super-admin, seed:dev
docs/API.md                every endpoint
docs/DATABASE.md           collections, indexes, production DB role
```
