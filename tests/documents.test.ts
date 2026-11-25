import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import mongoose from 'mongoose';
import { API, CLIENT, auditActions, bearer, createActiveAdmin, signInAdmin, signInCustomer, testApp, type SignedIn } from './helpers.js';
import { jpegWithGps, pdf, png, upload } from './fixtures.js';

const app = testApp();
const docs = () => mongoose.connection.db!.collection('documents');

async function linkAndFetch(s: SignedIn, docId: string) {
  const link = await request(app).post(`${API}/documents/${docId}/link`).set(bearer(s));
  if (link.status !== 200) return link;
  return request(app).get(link.body.url).set(bearer(s)).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

async function driverWithPhoto() {
  const s = await signInCustomer(app, '0788600001');
  const res = await upload(app, s, '/partners/driver/documents', 'profile_photo', await jpegWithGps());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { s, docId: res.body.documents[0].id as string };
}

describe('uploads: type, size and cleaning', () => {
  it('strips EXIF and GPS location from photos before storing them', async () => {
    const original = await jpegWithGps();
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const { s, docId } = await driverWithPhoto();
    const res = await linkAndFetch(s, docId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(res.body as Buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect((res.body as Buffer).includes(Buffer.from('Secret Person'))).toBe(false);
  });

  it('accepts PNG and PDF, decided by content', async () => {
    const s = await signInCustomer(app, '0788600002');
    expect((await upload(app, s, '/partners/driver/documents', 'id_document', await png(), 'scan.png')).status).toBe(201);
    expect((await upload(app, s, '/partners/driver/documents', 'driving_licence', pdf(), 'licence.pdf')).status).toBe(201);
  });

  it('rejects files whose content is not JPG, PNG or PDF, whatever the name says', async () => {
    const s = await signInCustomer(app, '0788600003');
    const fakes: Array<[Buffer, string]> = [
      [Buffer.from('MZ\x90\x00 this is a windows executable'), 'photo.jpg'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'id.png'],
      [Buffer.from('<html><script>alert(1)</script></html>'), 'licence.pdf'],
      [Buffer.from('GIF89a......'), 'photo.jpg'],
    ];
    for (const [body, name] of fakes) {
      const res = await upload(app, s, '/partners/driver/documents', 'id_document', body, name);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('unsupported_file_type');
    }
  });

  it('rejects a truncated or corrupt image that only starts like a JPEG', async () => {
    const s = await signInCustomer(app, '0788600004');
    const res = await upload(app, s, '/partners/driver/documents', 'id_document', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200, 7)]));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_file');
  });

  it('rejects files over 5 MB', async () => {
    const s = await signInCustomer(app, '0788600005');
    const big = Buffer.concat([pdf(), Buffer.alloc(5 * 1024 * 1024, 0x20)]);
    const res = await upload(app, s, '/partners/driver/documents', 'id_document', big, 'big.pdf');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('file_too_large');
  });

  it('rejects PDFs with JavaScript, launch actions or embedded files', async () => {
    const s = await signInCustomer(app, '0788600006');
    for (const extra of ['/OpenAction << /S /JavaScript /JS (app.alert(1)) >>', '/Names << /EmbeddedFiles 3 0 R >> /EmbeddedFile', '/Launch']) {
      const res = await upload(app, s, '/partners/driver/documents', 'id_document', pdf(extra), 'x.pdf');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_file');
    }
  });

  it('requires a photo (not a PDF) for profile and vehicle photos', async () => {
    const s = await signInCustomer(app, '0788600007');
    const res = await upload(app, s, '/partners/driver/documents', 'profile_photo', pdf(), 'me.pdf');
    expect(res.status).toBe(400);
  });

  it('refuses a document kind that does not belong to the subject', async () => {
    const s = await signInCustomer(app, '0788600008');
    const res = await upload(app, s, '/partners/driver/documents', 'insurance', pdf(), 'x.pdf');
    expect(res.status).toBe(400);
  });

  it('stores files encrypted, under random names, outside any public folder', async () => {
    const { s, docId } = await driverWithPhoto();
    const row = await docs().findOne({ _id: new mongoose.Types.ObjectId(docId) });
    expect(row!.storageKey).toMatch(/^docs\/[a-f0-9]{48}$/);
    const raw = fs.readFileSync(path.join(process.env.STORAGE_LOCAL_DIR!, row!.storageKey));
    expect(raw.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false); // not a readable JPEG on disk
    // Nothing under the API serves storage paths directly.
    await request(app).get(`/${row!.storageKey}`).expect(404);
    await request(app).get(`/uploads/${row!.storageKey}`).expect(404);
    // The metadata API never exposes the storage key.
    const view = await request(app).get(`${API}/partners/driver`).set(bearer(s)).expect(200);
    expect(JSON.stringify(view.body)).not.toContain(row!.storageKey);
  });
});

describe('document access: 5-minute links bound to the session', () => {
  it('lets the owner view their own document', async () => {
    const { s, docId } = await driverWithPhoto();
    const res = await linkAndFetch(s, docId);
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('hides other people’s documents (404, not 403)', async () => {
    const { docId } = await driverWithPhoto();
    const other = await signInCustomer(app, '0788600099');
    const res = await request(app).post(`${API}/documents/${docId}/link`).set(bearer(other));
    expect(res.status).toBe(404);
  });

  it('lets an admin view a partner document and logs every view', async () => {
    const { docId } = await driverWithPhoto();
    const ops = await createActiveAdmin('staff');
    const a = await signInAdmin(app, ops);
    expect((await linkAndFetch(a, docId)).status).toBe(200);
    expect((await linkAndFetch(a, docId)).status).toBe(200);
    const views = await mongoose.connection.db!.collection('auditLogs').find({ action: 'document.viewed_by_admin', targetId: docId }).toArray();
    expect(views).toHaveLength(2);
    expect(String(views[0]!.actorId)).toBe(ops.userId);
  });

  it('refuses a link after it expires, with a tampered signature, from another session, or when signed out', async () => {
    const { s, docId } = await driverWithPhoto();
    const link = await request(app).post(`${API}/documents/${docId}/link`).set(bearer(s)).expect(200);
    const url = new URL(link.body.url, 'http://x');
    expect(Number(url.searchParams.get('exp')) - Date.now()).toBeLessThanOrEqual(5 * 60_000);

    // signed out (no bearer token)
    await request(app).get(link.body.url).expect(401);
    // tampered signature
    await request(app).get(link.body.url.replace(/sig=[^&]+/, 'sig=' + 'A'.repeat(43))).set(bearer(s)).expect(403);
    // expired
    const past = Date.now() - 1000;
    await request(app).get(`${API}/documents/${docId}/content?exp=${past}&sig=${url.searchParams.get('sig')}`).set(bearer(s)).expect(410);
    // the same user, a different session: the link is not valid there
    await mongoose.connection.db!.collection('otpStates').updateMany({}, { $set: { lastSentAt: new Date(0) } });
    const second = await signInCustomer(app, '0788600001');
    await request(app).get(link.body.url).set(bearer(second)).expect(403);
    // after logout the original session's link stops working too
    await request(app).post(`${API}/auth/logout`).set(CLIENT).set(bearer(s)).expect(204);
    await request(app).get(link.body.url).set(bearer(s)).expect(401);
  });

  it('records document uploads in the audit log', async () => {
    await driverWithPhoto();
    expect(await auditActions()).toContain('document.uploaded');
  });
});
