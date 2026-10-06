import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/env';
import { FsStorage } from './fs';
import { MemoryStorage } from './memory';
import { S3Storage } from './s3';

const base = { DATABASE_URL: 'x', JWT_ACCESS_SECRET: 'a'.repeat(32) };

describe('S3Storage signed URLs', () => {
  it('signs private reads that expire in 15 minutes, against the public endpoint', async () => {
    const storage = new S3Storage(
      loadConfig({
        ...base,
        S3_BUCKET: 'calcam-meals',
        S3_ENDPOINT: 'http://minio:9000',
        S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
        S3_FORCE_PATH_STYLE: 'true',
        S3_ACCESS_KEY_ID: 'minio',
        S3_SECRET_ACCESS_KEY: 'minio-secret',
      }),
    );
    const url = new URL(await storage.signedUrl('users/u1/meals/m1.jpg'));
    // The container-internal hostname must not leak into URLs the phone has to open.
    expect(url.origin).toBe('http://localhost:9000');
    expect(url.pathname).toBe('/calcam-meals/users/u1/meals/m1.jpg');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses virtual-hosted style on AWS and honours a custom TTL', async () => {
    const storage = new S3Storage(loadConfig({ ...base, S3_BUCKET: 'prod-bucket', S3_REGION: 'ap-southeast-1', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }));
    const url = new URL(await storage.signedUrl('a/b.jpg', 60));
    expect(url.hostname).toBe('prod-bucket.s3.ap-southeast-1.amazonaws.com');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
  });
});

describe('FsStorage (development driver)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'calcam-fs-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const storage = new FsStorage(loadConfig({ ...base, STORAGE_FS_DIR: dir, PUBLIC_BASE_URL: 'http://localhost:3000' }));

  it('round-trips, deletes by key and by prefix', async () => {
    await storage.put('users/u1/meals/a.jpg', Buffer.from('A'));
    await storage.put('users/u1/meals/b.jpg', Buffer.from('B'));
    await storage.put('users/u2/meals/c.jpg', Buffer.from('C'));
    expect((await storage.get('users/u1/meals/a.jpg')).toString()).toBe('A');
    await storage.delete('users/u1/meals/a.jpg');
    await expect(storage.get('users/u1/meals/a.jpg')).rejects.toThrow();
    await storage.deletePrefix('users/u1/');
    await expect(storage.get('users/u1/meals/b.jpg')).rejects.toThrow();
    expect((await storage.get('users/u2/meals/c.jpg')).toString()).toBe('C'); // other users untouched
  });

  it('refuses keys that escape the storage root', async () => {
    await expect(storage.put('../../etc/evil', Buffer.from('x'))).rejects.toThrow('Invalid storage key');
    await expect(storage.get('users/../../secret')).rejects.toThrow('Invalid storage key');
  });

  it('signs links that expire and cannot be tampered with', async () => {
    const url = new URL(await storage.signedUrl('users/u1/meals/a.jpg', 60));
    const key = url.pathname.replace('/dev-storage/', '');
    const expires = Number(url.searchParams.get('expires'));
    const sig = url.searchParams.get('sig')!;
    expect(storage.verify(key, expires, sig)).toBe(true);
    expect(storage.verify('users/u2/meals/c.jpg', expires, sig)).toBe(false); // different object
    expect(storage.verify(key, expires + 1, sig)).toBe(false); // extended lifetime
    expect(storage.verify(key, Math.floor(Date.now() / 1000) - 1, storage.sign(key, Math.floor(Date.now() / 1000) - 1))).toBe(false); // expired
  });
});

describe('MemoryStorage', () => {
  it('deletes by prefix', async () => {
    const m = new MemoryStorage();
    await m.put('users/a/1.jpg', Buffer.from('1'), 'image/jpeg');
    await m.put('users/ab/2.jpg', Buffer.from('2'), 'image/jpeg');
    await m.deletePrefix('users/a/');
    expect([...m.objects.keys()]).toEqual(['users/ab/2.jpg']);
  });
});
