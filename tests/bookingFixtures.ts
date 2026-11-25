import crypto from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { UserModel } from '../src/modules/users/user.model.js';
import { DriverProfileModel, OwnerProfileModel, VehicleModel } from '../src/modules/partners/partner.models.js';
import { DocumentModel } from '../src/modules/documents/document.model.js';
import { storage } from '../src/modules/storage/storage.js';
import { withTransaction } from '../src/db/transaction.js';
import { saveConfigVersion } from '../src/modules/platformConfig/platformConfig.service.js';
import { DEV_PLACEHOLDER_CONFIG } from '../src/modules/platformConfig/platformConfig.schema.js';
import { normalizePhone } from '../src/lib/phone.js';
import { API, bearer, type SignedIn, type testApp } from './helpers.js';

type App = ReturnType<typeof testApp>;
const DAY = 86_400_000;
export const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

export async function seedConfig() {
  return withTransaction((s) => saveConfigVersion({ values: DEV_PLACEHOLDER_CONFIG, isPlaceholder: true, createdBySystem: 'test' }, s));
}

async function approvedDoc(ownerId: unknown, subjectType: 'driver' | 'vehicle' | 'owner', subjectId: unknown, kind: string, expiresAt: Date | null, image = false) {
  const key = `docs/${crypto.randomBytes(24).toString('hex')}`;
  const body = image ? await sharp({ create: { width: 8, height: 8, channels: 3, background: '#333' } }).jpeg().toBuffer() : Buffer.from('%PDF-1.4\n%%EOF\n');
  await storage().put(key, body, image ? 'image/jpeg' : 'application/pdf');
  await DocumentModel.create({
    ownerId,
    subjectType,
    subjectId,
    kind,
    status: 'approved',
    storageKey: key,
    contentType: image ? 'image/jpeg' : 'application/pdf',
    extension: image ? 'jpg' : 'pdf',
    size: body.length,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    expiresAt,
  });
}

/** An approved, available driver (created directly; the approval flow has its own tests). */
export async function approvedDriver(phone: string, firstName = 'Eric') {
  const user = await UserModel.create({ phone: normalizePhone(phone), firstName, lastName: 'Driver', roles: ['customer', 'driver_partner'], status: 'active' });
  const profile = await DriverProfileModel.create({
    userId: user._id,
    status: 'approved',
    contactPhone: user.phone,
    licenceNumber: 'X',
    licenceExpiry: new Date(Date.now() + 400 * DAY),
    experienceYears: 5,
    areas: ['Kigali'],
    languages: ['English'],
    availability: { acceptingTrips: true, unavailable: [] },
  });
  await approvedDoc(user._id, 'driver', profile._id, 'driving_licence', new Date(Date.now() + 400 * DAY));
  await approvedDoc(user._id, 'driver', profile._id, 'profile_photo', null, true);
  return { userId: user.id as string, profileId: profile.id as string, phone };
}

/** An approved owner with one approved, available vehicle. */
export async function approvedVehicle(ownerPhone: string, opts: { seats?: number; plate?: string } = {}) {
  const user = await UserModel.create({ phone: normalizePhone(ownerPhone), firstName: 'Grace', lastName: 'Owner', roles: ['customer', 'vehicle_partner'], status: 'active' });
  const owner = await OwnerProfileModel.create({ userId: user._id, status: 'approved', type: 'individual', contactPhone: user.phone });
  const vehicle = await VehicleModel.create({
    ownerUserId: user._id,
    ownerProfileId: owner._id,
    status: 'approved',
    make: 'Toyota',
    model: 'Prado',
    year: 2021,
    plate: opts.plate ?? `RAB${crypto.randomInt(100, 999)}C`,
    colour: 'Black',
    category: 'suv',
    seats: opts.seats ?? 6,
    availability: { acceptingTrips: true, unavailable: [] },
  });
  await approvedDoc(user._id, 'vehicle', vehicle._id, 'insurance', new Date(Date.now() + 300 * DAY));
  return { ownerUserId: user.id as string, vehicleId: vehicle.id as string, ownerPhone };
}

export function chauffeurRequest(startAt: Date, extra: Record<string, unknown> = {}) {
  return {
    service: 'chauffeur',
    pickup: { address: 'Kigali Marriott Hotel, KN 3 Ave' },
    dropoff: { address: 'Kigali International Airport' },
    airport: { direction: 'to_airport', flightNumber: 'WB 302' },
    startAt: startAt.toISOString(),
    durationHours: 2,
    passengers: 2,
    ...extra,
  };
}

export function driverOnDemandRequest(startAt: Date, extra: Record<string, unknown> = {}) {
  return {
    service: 'driver_on_demand',
    pickup: { address: 'Kacyiru, KG 7 Ave' },
    startAt: startAt.toISOString(),
    durationHours: 4,
    passengers: 1,
    customerVehicle: { make: 'Toyota', model: 'RAV4', plate: 'RAD 456 B', transmission: 'automatic' },
    ...extra,
  };
}

export async function book(app: App, customer: SignedIn, body: object) {
  const res = await request(app).post(`${API}/bookings`).set(bearer(customer)).send(body);
  if (res.status !== 201) throw new Error(`booking failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; ref: string };
}

export async function quote(app: App, staff: SignedIn, bookingId: string, body: object) {
  return request(app).post(`${API}/admin/bookings/${bookingId}/quote`).set(bearer(staff)).send(body);
}
