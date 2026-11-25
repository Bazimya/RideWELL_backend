import request from 'supertest';
import sharp from 'sharp';
import { expect } from 'vitest';
import { API, bearer, type SignedIn, type testApp } from './helpers.js';

type App = ReturnType<typeof testApp>;

/** A real JPEG photo carrying EXIF including GPS coordinates (Kigali). */
export async function jpegWithGps(seed = 0): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 40 + seed, g: 80, b: 120 } } })
    .jpeg()
    .withExif({
      IFD0: { Artist: 'Secret Person', Make: 'PhoneCo' },
      IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '1/1 56/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '30/1 3/1 0/1' },
    })
    .toBuffer();
}

export async function png(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
}

export function pdf(extra = ''): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R ${extra} >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    'latin1',
  );
}

export async function upload(app: App, s: SignedIn, path: string, kind: string, body: Buffer, filename = 'file.jpg') {
  return request(app).post(`${API}${path}`).set(bearer(s)).field('kind', kind).attach('file', body, filename);
}

export const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

/** Fill in and submit a complete driver application. */
export async function submitCompleteDriver(app: App, s: SignedIn) {
  await request(app).patch(`${API}/me`).set(bearer(s)).send({ firstName: 'Eric', lastName: 'Driver' }).expect(200);
  await request(app)
    .put(`${API}/partners/driver`)
    .set(bearer(s))
    .send({
      contactPhone: '0788300001',
      licenceNumber: 'RW-123456',
      licenceExpiry: inDays(400).toISOString(),
      licenceCategories: ['B'],
      experienceYears: 6,
      areas: ['Kigali'],
      languages: ['English', 'Kinyarwanda'],
      references: [
        { name: 'Ref One', phone: '0788300002', relationship: 'Former employer' },
        { name: 'Ref Two', phone: '0788300003', relationship: 'Colleague' },
      ],
    })
    .expect(200);
  for (const kind of ['id_document', 'driving_licence', 'profile_photo']) {
    const res = await upload(app, s, '/partners/driver/documents', kind, await jpegWithGps());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
  const sub = await request(app).post(`${API}/partners/driver/submit`).set(bearer(s));
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  return sub.body as { profile: { id: string; status: string }; documents: Array<{ id: string; kind: string }> };
}

/** Fill in and submit a complete individual owner application. */
export async function submitCompleteOwner(app: App, s: SignedIn) {
  await request(app).patch(`${API}/me`).set(bearer(s)).send({ firstName: 'Grace', lastName: 'Owner' }).expect(200);
  await request(app)
    .put(`${API}/partners/owner`)
    .set(bearer(s))
    .send({ contactPhone: '0788400001', type: 'individual', payout: { method: 'momo', momoPhone: '0788400001', momoName: 'Grace Owner' } })
    .expect(200);
  expect((await upload(app, s, '/partners/owner/documents', 'id_document', pdf(), 'id.pdf')).status).toBe(201);
  const sub = await request(app).post(`${API}/partners/owner/submit`).set(bearer(s));
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  return sub.body as { profile: { id: string } };
}

/** Create a vehicle with all documents and submit it. */
export async function submitCompleteVehicle(app: App, s: SignedIn, plate = 'RAB 123 C') {
  const created = await request(app)
    .post(`${API}/partners/vehicles`)
    .set(bearer(s))
    .send({
      make: 'Toyota',
      model: 'Land Cruiser Prado',
      year: 2021,
      plate,
      colour: 'Black',
      category: 'suv',
      seats: 7,
      insurer: 'Radiant',
      insuranceExpiry: inDays(200).toISOString(),
      proposedRates: { dailyRwf: 120_000, airportTransferRwf: 40_000 },
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.vehicle.id as string;
  for (const kind of ['registration_certificate', 'ownership_proof', 'insurance']) {
    expect((await upload(app, s, `/partners/vehicles/${id}/documents`, kind, pdf(), 'doc.pdf')).status).toBe(201);
  }
  for (let i = 0; i < 4; i++) expect((await upload(app, s, `/partners/vehicles/${id}/documents`, 'vehicle_photo', await jpegWithGps(i))).status).toBe(201);
  const sub = await request(app).post(`${API}/partners/vehicles/${id}/submit`).set(bearer(s));
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  return sub.body as { vehicle: { id: string; status: string }; documents: Array<{ id: string; kind: string }> };
}

/** Approve every pending document of an admin view (expiring kinds get a future expiry). */
export async function approveAllDocuments(app: App, admin: SignedIn, view: { documents: Array<{ id: string; kind: string; status: string }> }) {
  let last: request.Response | null = null;
  for (const d of view.documents.filter((x) => x.status === 'pending')) {
    const body: Record<string, unknown> = { decision: 'approved' };
    if (d.kind === 'driving_licence' || d.kind === 'insurance') body.expiresAt = inDays(365).toISOString();
    last = await request(app).post(`${API}/admin/partners/documents/${d.id}/review`).set(bearer(admin)).send(body);
    expect(last.status, JSON.stringify(last.body)).toBe(200);
  }
  return last?.body;
}
