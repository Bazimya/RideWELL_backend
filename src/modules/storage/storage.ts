import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * Private object storage. Files are never served from a public folder: the API
 * reads them through this interface and streams them to an authorised caller.
 */
export interface ObjectStorage {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const SAFE_KEY = /^[a-z0-9][a-z0-9/_-]{10,200}$/;
function checkKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error('invalid storage key');
}

/**
 * DEVELOPMENT ONLY. Files on local disk, each encrypted with AES-256-GCM using
 * DATA_ENCRYPTION_KEY, in a directory the web server never serves. Refused in
 * production (env.ts).
 */
export class LocalEncryptedStorage implements ObjectStorage {
  readonly name = 'local-encrypted';
  constructor(private readonly root: string, private readonly key: Buffer) {}

  private file(key: string) {
    checkKey(key);
    return path.join(this.root, key);
  }

  async put(key: string, body: Buffer): Promise<void> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(body), cipher.final()]);
    const target = this.file(key);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, Buffer.concat([iv, cipher.getAuthTag(), ct]), { mode: 0o600, flag: 'wx' });
  }

  async get(key: string): Promise<Buffer> {
    const raw = await fs.readFile(this.file(key));
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true });
  }
}

/**
 * Any S3-compatible private bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO).
 * Objects are written with server-side encryption. The bucket must block all
 * public access; the API never hands out bucket URLs.
 *
 * NOT YET TESTED against a live bucket: no storage provider credentials exist yet.
 */
export class S3Storage implements ObjectStorage {
  readonly name = 's3';
  private clientPromise: Promise<import('@aws-sdk/client-s3').S3Client>;
  constructor(private readonly bucket: string, opts: { endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string }) {
    this.clientPromise = import('@aws-sdk/client-s3').then(
      ({ S3Client }) =>
        new S3Client({
          region: opts.region,
          endpoint: opts.endpoint,
          forcePathStyle: Boolean(opts.endpoint),
          credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
        }),
    );
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    checkKey(key);
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.clientPromise).send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256', IfNoneMatch: '*' }),
    );
  }

  async get(key: string): Promise<Buffer> {
    checkKey(key);
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const res = await (await this.clientPromise).send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error('empty object');
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    checkKey(key);
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.clientPromise).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let instance: ObjectStorage | null = null;

export function storage(): ObjectStorage {
  if (!instance) {
    const e = env();
    instance =
      e.STORAGE_DRIVER === 's3'
        ? new S3Storage(e.S3_BUCKET!, {
            endpoint: e.S3_ENDPOINT,
            region: e.S3_REGION,
            accessKeyId: e.S3_ACCESS_KEY_ID!,
            secretAccessKey: e.S3_SECRET_ACCESS_KEY!,
          })
        : new LocalEncryptedStorage(path.resolve(e.STORAGE_LOCAL_DIR), Buffer.from(e.DATA_ENCRYPTION_KEY, 'base64'));
  }
  return instance;
}

/** Test helper. */
export function resetStorage(): void {
  instance = null;
}
