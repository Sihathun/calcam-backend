import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Config } from '../../config/env';
import type { ObjectStorage } from './index';

/**
 * Local-disk storage for development without Docker. Works across the API and worker processes.
 * Signed URLs are served by the /dev-storage route in app.ts, which is only mounted for this driver.
 */
export class FsStorage implements ObjectStorage {
  private readonly root: string;

  constructor(private readonly config: Config) {
    this.root = resolve(config.storage.fsDir);
  }

  private pathFor(key: string): string {
    const p = resolve(this.root, key);
    if (p !== this.root && !p.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return p;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.pathFor(prefix), { recursive: true, force: true });
  }

  sign(key: string, expires: number): string {
    return createHmac('sha256', this.config.storage.signingSecret).update(`${key}:${expires}`).digest('hex');
  }

  verify(key: string, expires: number, sig: string): boolean {
    if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
    const expected = Buffer.from(this.sign(key, expires));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  async signedUrl(key: string, ttlSeconds = this.config.storage.signedUrlTtlSeconds): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const base = this.config.publicBaseUrl.replace(/\/$/, '');
    return `${base}/dev-storage/${key}?expires=${expires}&sig=${this.sign(key, expires)}`;
  }

  async ping(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }
}
