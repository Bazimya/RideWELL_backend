/**
 * DEVELOPMENT DEMO DATA. Refuses to run in production.
 *
 *   npm run seed:demo            create the demo data (skips anything that already exists)
 *   npm run seed:demo -- --reset remove all demo data first, then create it again
 *
 * Everything is clearly labelled as demo: last names end in "[DEMO]", emails are
 * demo.*@ridewell.test, plates start with "DEM", and every photo and document is a
 * generated image or PDF stamped "DEMO". All demo accounts share the password in
 * DEV_DEMO_PASSWORD (.env).
 *
 * The data is built through the real application flows (application, upload with
 * inspection and encrypted storage, admin review, checks, approval), so it behaves
 * exactly like real data. Reviews are recorded as done by the dev super admin
 * (run `npm run seed:dev-accounts` first).
 */
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase, ensureIndexes } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { withTransaction } from '../db/transaction.js';
import { UserModel } from '../modules/users/user.model.js';
import { hashPassword } from '../modules/auth/password.js';
import { DocumentModel, type DocumentKind } from '../modules/documents/document.model.js';
import { listDocuments, reviewDocument, uploadDocument } from '../modules/documents/document.service.js';
import { DriverProfileModel, OwnerProfileModel, VehicleModel } from '../modules/partners/partner.models.js';
import {
  createVehicle,
  decide,
  getOrCreateDriverProfile,
  getOrCreateOwnerProfile,
  recordDriverCheck,
  recordInspection,
  setDriverAvailability,
  setVehicleAvailability,
  startReview,
  submitDriverApplication,
  submitOwnerApplication,
  submitVehicle,
  updateDriverProfile,
  updateOwnerProfile,
} from '../modules/partners/partner.service.js';
import type { AuditActor } from '../modules/audit/audit.service.js';

type UserActor = AuditActor & { type: 'user' };
const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY);

// ---------------------------------------------------------------------------
// Generated demo files (never real IDs or photos)
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

async function demoPortrait(initials: string, hue: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480">
    <rect width="480" height="480" fill="hsl(${hue},45%,22%)"/>
    <circle cx="240" cy="190" r="92" fill="hsl(${hue},35%,55%)"/>
    <rect x="110" y="300" width="260" height="180" rx="120" fill="hsl(${hue},35%,55%)"/>
    <text x="240" y="215" font-family="Helvetica, Arial" font-size="78" font-weight="700" fill="#fff" text-anchor="middle">${esc(initials)}</text>
    <rect x="0" y="420" width="480" height="60" fill="#e5232f"/>
    <text x="240" y="462" font-family="Helvetica, Arial" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">DEMO PHOTO</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

async function demoCarPhoto(label: string, colour: string, angle: number): Promise<Buffer> {
  const views = ['FRONT', 'SIDE', 'REAR', 'INTERIOR'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e232b"/><stop offset="1" stop-color="#07080a"/></linearGradient></defs>
    <rect width="800" height="500" fill="url(#g)"/>
    <ellipse cx="400" cy="380" rx="300" ry="18" fill="#000" opacity="0.6"/>
    <path d="M120 340 C120 310 140 298 180 292 L270 278 C320 236 370 214 440 212 L540 214 C590 218 630 244 668 276 L700 286 C724 292 734 306 732 330 L730 350 L120 350 Z" fill="${esc(colour)}" stroke="#ffffff33" stroke-width="2"/>
    <path d="M290 280 C330 246 375 228 440 226 L530 228 C572 232 608 252 640 276 Z" fill="#9fb3c8" opacity="0.55"/>
    <circle cx="250" cy="352" r="38" fill="#0b0c10" stroke="#59606b" stroke-width="6"/>
    <circle cx="610" cy="352" r="38" fill="#0b0c10" stroke="#59606b" stroke-width="6"/>
    <text x="400" y="80" font-family="Helvetica, Arial" font-size="36" font-weight="700" fill="#fff" text-anchor="middle">${esc(label)}</text>
    <text x="400" y="124" font-family="Helvetica, Arial" font-size="24" fill="#a3acb7" text-anchor="middle">${views[angle % 4]} VIEW</text>
    <rect x="0" y="440" width="800" height="60" fill="#e5232f"/>
    <text x="400" y="481" font-family="Helvetica, Arial" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">DEMO PHOTO · NOT A REAL VEHICLE</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

/** A minimal, valid PDF page whose only content is a "DEMO DOCUMENT" notice. */
function demoPdf(title: string): Buffer {
  const text = `DEMO DOCUMENT - NOT REAL - ${title}`.replace(/[()\\]/g, '');
  const stream = `BT /F1 18 Tf 50 750 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// ---------------------------------------------------------------------------
// Demo people and vehicles
// ---------------------------------------------------------------------------

type DriverState = 'approved' | 'approved_unavailable' | 'applied' | 'under_review';

const CUSTOMERS = [
  { first: 'Aline', last: 'Uwase', phone: '+250788900001' },
  { first: 'David', last: 'Kamanzi', phone: '+250788900002' },
  { first: 'Sarah', last: 'Mutoni', phone: null },
];

const DRIVERS: Array<{ first: string; last: string; phone: string; years: number; areas: string[]; languages: string[]; state: DriverState; hue: number }> = [
  { first: 'Eric', last: 'Habimana', phone: '+250788910001', years: 9, areas: ['Kigali', 'Musanze'], languages: ['Kinyarwanda', 'English', 'French'], state: 'approved', hue: 205 },
  { first: 'Grace', last: 'Ingabire', phone: '+250788910002', years: 6, areas: ['Kigali'], languages: ['Kinyarwanda', 'English'], state: 'approved', hue: 330 },
  { first: 'Jean Paul', last: 'Niyonzima', phone: '+250788910003', years: 12, areas: ['Kigali', 'Huye', 'Rubavu'], languages: ['Kinyarwanda', 'French', 'Swahili'], state: 'approved', hue: 25 },
  { first: 'Claudine', last: 'Mukamana', phone: '+250788910004', years: 5, areas: ['Kigali'], languages: ['Kinyarwanda', 'English'], state: 'approved', hue: 140 },
  { first: 'Patrick', last: 'Nshimiyimana', phone: '+250788910005', years: 15, areas: ['Kigali', 'Akagera'], languages: ['Kinyarwanda', 'English', 'French'], state: 'approved', hue: 260 },
  { first: 'Olivier', last: 'Mugisha', phone: '+250788910006', years: 7, areas: ['Kigali'], languages: ['Kinyarwanda', 'English'], state: 'approved_unavailable', hue: 50 },
  { first: 'Diane', last: 'Uwimana', phone: '+250788910007', years: 4, areas: ['Kigali'], languages: ['Kinyarwanda', 'French'], state: 'applied', hue: 300 },
  { first: 'Fabrice', last: 'Twagirayezu', phone: '+250788910008', years: 3, areas: ['Kigali', 'Rwamagana'], languages: ['Kinyarwanda', 'English'], state: 'under_review', hue: 175 },
];

type VehicleState = 'approved' | 'insurance_expiring' | 'applied';
const OWNERS: Array<{
  first: string;
  last: string;
  phone: string;
  company?: { name: string; rdb: string; tin: string };
  vehicles: Array<{ make: string; model: string; year: number; plate: string; colour: string; hex: string; category: 'sedan' | 'suv' | 'executive' | 'van' | 'minibus'; seats: number; insurer: string; rates: { hourlyRwf?: number; dailyRwf?: number; airportTransferRwf?: number }; state: VehicleState }>;
}> = [
  {
    first: 'Emmanuel',
    last: 'Rukundo',
    phone: '+250788920001',
    vehicles: [
      { make: 'Toyota', model: 'Land Cruiser Prado', year: 2021, plate: 'DEM 101 A', colour: 'Black', hex: '#15181d', category: 'suv', seats: 7, insurer: 'Radiant', rates: { dailyRwf: 150_000, airportTransferRwf: 45_000 }, state: 'approved' },
      { make: 'Toyota', model: 'Corolla', year: 2019, plate: 'DEM 102 A', colour: 'White', hex: '#e8e8e8', category: 'sedan', seats: 4, insurer: 'Sanlam', rates: { hourlyRwf: 12_000, airportTransferRwf: 25_000 }, state: 'approved' },
    ],
  },
  {
    first: 'Josiane',
    last: 'Uwera',
    phone: '+250788920002',
    vehicles: [
      { make: 'Mercedes-Benz', model: 'E-Class', year: 2020, plate: 'DEM 201 B', colour: 'Silver', hex: '#9aa1a9', category: 'executive', seats: 4, insurer: 'Prime Insurance', rates: { hourlyRwf: 25_000, dailyRwf: 220_000, airportTransferRwf: 60_000 }, state: 'approved' },
      { make: 'Lexus', model: 'RX 350', year: 2022, plate: 'DEM 202 B', colour: 'Dark grey', hex: '#3a3f47', category: 'executive', seats: 4, insurer: 'Radiant', rates: { dailyRwf: 200_000 }, state: 'insurance_expiring' },
    ],
  },
  {
    first: 'Kevin',
    last: 'Hakizimana',
    phone: '+250788920003',
    company: { name: 'Kivu Executive Cars Ltd [DEMO]', rdb: 'DEMO-RDB-104552', tin: 'DEMO-TIN-998877' },
    vehicles: [
      { make: 'Toyota', model: 'Hiace', year: 2018, plate: 'DEM 301 C', colour: 'White', hex: '#dcdcdc', category: 'van', seats: 12, insurer: 'Sonarwa', rates: { dailyRwf: 180_000, airportTransferRwf: 55_000 }, state: 'approved' },
      { make: 'Toyota', model: 'Coaster', year: 2017, plate: 'DEM 302 C', colour: 'Cream', hex: '#d9cfb7', category: 'minibus', seats: 26, insurer: 'Sonarwa', rates: { dailyRwf: 300_000 }, state: 'approved' },
      { make: 'Toyota', model: 'RAV4', year: 2023, plate: 'DEM 303 C', colour: 'Blue', hex: '#2a4a7a', category: 'suv', seats: 5, insurer: 'Prime Insurance', rates: { hourlyRwf: 15_000, dailyRwf: 130_000 }, state: 'approved' },
      { make: 'Hyundai', model: 'Tucson', year: 2021, plate: 'DEM 304 C', colour: 'Red', hex: '#8f1d22', category: 'suv', seats: 5, insurer: 'Radiant', rates: { dailyRwf: 120_000 }, state: 'applied' },
    ],
  },
];

const email = (first: string, last: string, kind: string) =>
  `demo.${kind}.${`${first}.${last}`.toLowerCase().normalize('NFD').replace(/[^a-z.]/g, '')}@ridewell.test`;

// ---------------------------------------------------------------------------

async function demoUser(input: { email: string; first: string; last: string; phone: string | null }, passwordHash: string) {
  const existing = await UserModel.findOne({ email: input.email });
  if (existing) return { user: existing, created: false };
  const user = await UserModel.create({
    email: input.email,
    phone: input.phone ?? undefined,
    firstName: input.first,
    lastName: `${input.last} [DEMO]`,
    roles: ['customer'],
    status: 'active',
    passwordHash,
    passwordChangedAt: new Date(),
    ...(input.phone ? { phoneVerifiedAt: new Date() } : {}),
  });
  return { user, created: true };
}

const selfActor = (u: { _id: unknown; roles: string[] }): UserActor => ({ type: 'user', id: String(u._id), roles: u.roles });

async function approveAllPending(subjectType: 'driver' | 'owner' | 'vehicle', subjectId: mongoose.Types.ObjectId, reviewer: UserActor, expiry: Date) {
  for (const d of await listDocuments(subjectType, subjectId)) {
    if (d.status !== 'pending') continue;
    await withTransaction((session) =>
      reviewDocument(
        {
          docId: String(d._id),
          decision: 'approved',
          note: 'DEMO seed',
          expiresAt: d.kind === 'driving_licence' || d.kind === 'insurance' ? expiry : null,
          actor: reviewer,
        },
        session,
      ),
    );
  }
}

async function upload(ownerId: string, subjectType: 'driver' | 'owner' | 'vehicle', subjectId: mongoose.Types.ObjectId, kind: DocumentKind, buffer: Buffer, actor: UserActor) {
  await uploadDocument({ ownerId, subjectType, subjectId, kind, buffer, actor });
}

async function seedDriver(d: (typeof DRIVERS)[number], passwordHash: string, reviewer: UserActor) {
  const { user, created } = await demoUser({ email: email(d.first, d.last, 'driver'), first: d.first, last: d.last, phone: d.phone }, passwordHash);
  if (!created) return `  · ${d.first} ${d.last}: exists, skipped`;
  const actor = selfActor(user);
  const profile = await getOrCreateDriverProfile(user.id);
  await updateDriverProfile(
    user.id,
    {
      contactPhone: d.phone,
      licenceNumber: `DEMO-${d.phone.slice(-6)}`,
      licenceExpiry: inDays(700),
      licenceCategories: ['B', 'C'],
      experienceYears: d.years,
      areas: d.areas,
      languages: d.languages,
      bio: `[DEMO] ${d.years} years of professional driving in ${d.areas.join(', ')}.`,
      references: [
        { name: 'Demo Reference One', phone: '+250788999101', relationship: 'Former employer' },
        { name: 'Demo Reference Two', phone: '+250788999102', relationship: 'Client' },
      ],
    },
    actor,
  );
  const initials = `${d.first[0]}${d.last[0]}`;
  await upload(user.id, 'driver', profile._id, 'id_document', demoPdf(`National ID - ${d.first} ${d.last}`), actor);
  await upload(user.id, 'driver', profile._id, 'driving_licence', demoPdf(`Driving licence - ${d.first} ${d.last}`), actor);
  await upload(user.id, 'driver', profile._id, 'profile_photo', await demoPortrait(initials, d.hue), actor);
  await submitDriverApplication(user.id, actor);
  if (d.state === 'applied') return `  · ${d.first} ${d.last}: submitted, waiting for review`;

  await startReview('driver', profile.id, reviewer);
  if (d.state === 'under_review') {
    // Half-way through a review: ID approved, the rest still to do.
    const idDoc = await DocumentModel.findOne({ subjectType: 'driver', subjectId: profile._id, kind: 'id_document', status: 'pending' }).lean();
    if (idDoc) await withTransaction((s) => reviewDocument({ docId: String(idDoc._id), decision: 'approved', note: 'DEMO seed', actor: reviewer }, s));
    await recordDriverCheck(profile.id, 'interview', 'passed', 'DEMO seed', reviewer);
    return `  · ${d.first} ${d.last}: under review (ID approved, interview passed; licence, photo, test and references to do)`;
  }
  await approveAllPending('driver', profile._id, reviewer, inDays(700));
  for (const check of ['interview', 'drivingTest', 'references'] as const) await recordDriverCheck(profile.id, check, 'passed', 'DEMO seed', reviewer);
  await decide('driver', profile.id, 'approve', null, reviewer);
  const accepting = d.state === 'approved';
  await setDriverAvailability(
    user.id,
    { acceptingTrips: accepting, unavailable: accepting ? [{ from: inDays(10), to: inDays(12), note: '[DEMO] family event' }] : [] },
    selfActor(await UserModel.findById(user.id).orFail()),
  );
  return `  · ${d.first} ${d.last}: approved, ${accepting ? 'accepting trips' : 'NOT accepting trips'}`;
}

async function seedOwner(o: (typeof OWNERS)[number], passwordHash: string, reviewer: UserActor) {
  const lines: string[] = [];
  const { user, created } = await demoUser({ email: email(o.first, o.last, 'owner'), first: o.first, last: o.last, phone: o.phone }, passwordHash);
  if (!created) return [`  · ${o.company?.name ?? `${o.first} ${o.last}`}: exists, skipped`];
  let actor = selfActor(user);
  const profile = await getOrCreateOwnerProfile(user.id);
  await updateOwnerProfile(
    user.id,
    {
      contactPhone: o.phone,
      type: o.company ? 'company' : 'individual',
      ...(o.company ? { companyName: o.company.name, rdbNumber: o.company.rdb, tinNumber: o.company.tin, representativeName: `${o.first} ${o.last}` } : {}),
      payout: { method: 'momo', momoPhone: o.phone, momoName: `${o.first} ${o.last} [DEMO]` },
    },
    actor,
  );
  await upload(user.id, 'owner', profile._id, 'id_document', demoPdf(`National ID - ${o.first} ${o.last}`), actor);
  if (o.company) await upload(user.id, 'owner', profile._id, 'rdb_certificate', demoPdf(`RDB certificate - ${o.company.name}`), actor);
  await submitOwnerApplication(user.id, actor);
  await startReview('owner', profile.id, reviewer);
  await approveAllPending('owner', profile._id, reviewer, inDays(700));
  await decide('owner', profile.id, 'approve', null, reviewer);
  lines.push(`  · ${o.company?.name ?? `${o.first} ${o.last}`}: approved owner`);
  actor = selfActor(await UserModel.findById(user.id).orFail());

  for (const v of o.vehicles) {
    const expiry = v.state === 'insurance_expiring' ? inDays(20) : inDays(300);
    const vehicle = await createVehicle(
      user.id,
      { make: v.make, model: v.model, year: v.year, plate: v.plate, colour: v.colour, category: v.category, seats: v.seats, insurer: v.insurer, insuranceExpiry: expiry, proposedRates: v.rates },
      actor,
    );
    const label = `${v.make} ${v.model} · ${v.plate}`;
    await upload(user.id, 'vehicle', vehicle._id, 'registration_certificate', demoPdf(`Registration - ${v.plate}`), actor);
    await upload(user.id, 'vehicle', vehicle._id, 'ownership_proof', demoPdf(`Ownership - ${v.plate}`), actor);
    await upload(user.id, 'vehicle', vehicle._id, 'insurance', demoPdf(`Insurance - ${v.plate}`), actor);
    for (let i = 0; i < 4; i++) await upload(user.id, 'vehicle', vehicle._id, 'vehicle_photo', await demoCarPhoto(label, v.hex, i), actor);
    await submitVehicle(user.id, vehicle.id, actor);
    if (v.state === 'applied') {
      lines.push(`      ${label}: submitted, waiting for review`);
      continue;
    }
    await startReview('vehicle', vehicle.id, reviewer);
    await approveAllPending('vehicle', vehicle._id, reviewer, expiry);
    await recordInspection(vehicle.id, 'passed', 'DEMO seed: clean, tyres and brakes good', reviewer);
    await decide('vehicle', vehicle.id, 'approve', null, reviewer);
    await setVehicleAvailability(user.id, vehicle.id, { acceptingTrips: true, unavailable: [] }, actor);
    lines.push(`      ${label}: approved, available${v.state === 'insurance_expiring' ? ' (insurance expires in 20 days)' : ''}`);
  }
  return lines;
}

async function reset() {
  const demoUsers = await UserModel.find({ email: /^demo\..*@ridewell\.test$/ }, { _id: 1 }).lean();
  const ids = demoUsers.map((u) => u._id);
  const db = mongoose.connection.db!;
  // Raw driver deletes on purpose: demo data only, development only.
  const r = await Promise.all([
    db.collection('documents').deleteMany({ ownerId: { $in: ids } }),
    db.collection('vehicles').deleteMany({ ownerUserId: { $in: ids } }),
    db.collection('partnerProfiles').deleteMany({ userId: { $in: ids } }),
    db.collection('driverProfiles').deleteMany({ userId: { $in: ids } }),
    db.collection('sessions').deleteMany({ userId: { $in: ids } }),
    db.collection('users').deleteMany({ _id: { $in: ids } }),
  ]);
  console.log(`Removed demo data: ${r[5].deletedCount} accounts, ${r[1].deletedCount} vehicles, ${r[0].deletedCount} documents (stored files are left in place).`);
}

async function main() {
  const e = env();
  if (e.NODE_ENV === 'production') {
    console.error('Refusing to create demo data in production.');
    process.exit(1);
  }
  const password = process.env.DEV_DEMO_PASSWORD;
  if (!password) throw new Error('Set DEV_DEMO_PASSWORD in .env (shared password for demo accounts).');
  const { values } = parseArgs({ options: { reset: { type: 'boolean', default: false } } });

  await connectDatabase(e.MONGODB_URI);
  await ensureIndexes();
  await runMigrations();

  const reviewerUser = await UserModel.findOne({ email: (process.env.DEV_SUPER_ADMIN_EMAIL ?? '').toLowerCase(), roles: 'super_admin' });
  if (!reviewerUser) throw new Error('Run `npm run seed:dev-accounts` first: demo reviews are recorded as done by the dev super admin.');
  const reviewer = selfActor(reviewerUser);

  if (values.reset) await reset();
  const passwordHash = await hashPassword(password);

  console.log('Customers:');
  for (const c of CUSTOMERS) {
    const { created } = await demoUser({ email: email(c.first, c.last, 'customer'), first: c.first, last: c.last, phone: c.phone }, passwordHash);
    console.log(`  · ${c.first} ${c.last}: ${created ? 'created' : 'exists, skipped'}`);
  }
  console.log('Drivers / chauffeurs:');
  for (const d of DRIVERS) console.log(await seedDriver(d, passwordHash, reviewer));
  console.log('Vehicle owners and vehicles:');
  for (const o of OWNERS) for (const line of await seedOwner(o, passwordHash, reviewer)) console.log(line);

  const counts = await Promise.all([
    DriverProfileModel.countDocuments({ status: 'approved' }),
    OwnerProfileModel.countDocuments({ status: 'approved' }),
    VehicleModel.countDocuments({ status: 'approved' }),
  ]);
  console.log(`\nApproved now: ${counts[0]} drivers, ${counts[1]} owners, ${counts[2]} vehicles. Sign in with any demo.*@ridewell.test email and DEV_DEMO_PASSWORD.`);
  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
