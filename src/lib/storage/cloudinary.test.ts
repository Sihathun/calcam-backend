import { Writable } from 'node:stream';
import { v2 as cloudinary } from 'cloudinary';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config/env';
import { CloudinaryStorage } from './cloudinary';

const base = { DATABASE_URL: 'x', JWT_ACCESS_SECRET: 'a'.repeat(32) };

describe('Cloudinary configuration', () => {
  const url = 'cloudinary://123456:s3cr3t@demo-cloud';

  it('reads CLOUDINARY_URL, and separate variables win over it', () => {
    const fromUrl = loadConfig({ ...base, STORAGE_DRIVER: 'cloudinary', CLOUDINARY_URL: url });
    expect(fromUrl.storage.cloudinary).toEqual({ cloudName: 'demo-cloud', apiKey: '123456', apiSecret: 's3cr3t', folder: '' });
    const separate = loadConfig({
      ...base,
      STORAGE_DRIVER: 'cloudinary',
      CLOUDINARY_URL: url,
      CLOUDINARY_CLOUD_NAME: 'other',
      CLOUDINARY_API_KEY: 'k',
      CLOUDINARY_API_SECRET: 's',
      CLOUDINARY_FOLDER: 'calcam/prod',
    });
    expect(separate.storage.cloudinary).toMatchObject({ cloudName: 'other', apiKey: 'k', apiSecret: 's', folder: 'calcam/prod' });
  });

  it('refuses to start without credentials, with a malformed URL, or with a non-hex token key', () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 'cloudinary' })).toThrow(/STORAGE_DRIVER=cloudinary needs CLOUDINARY_URL/);
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 'cloudinary', CLOUDINARY_URL: 'https://nope' })).toThrow(/expected cloudinary:\/\/API_KEY/);
    expect(() => loadConfig({ ...base, CLOUDINARY_AUTH_TOKEN_KEY: 'not hex!' })).toThrow(/CLOUDINARY_AUTH_TOKEN_KEY/);
  });

  it('is accepted in production (it is durable), unlike fs and memory', () => {
    const prod = { ...base, NODE_ENV: 'production', QUEUE_DRIVER: 'bullmq', AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k' };
    expect(() => loadConfig({ ...prod, STORAGE_DRIVER: 'cloudinary', CLOUDINARY_URL: url })).not.toThrow();
    expect(() => loadConfig({ ...prod, STORAGE_DRIVER: 'fs' })).toThrow(/not durable/);
  });
});

describe('CloudinaryStorage', () => {
  const env = { ...base, STORAGE_DRIVER: 'cloudinary', CLOUDINARY_URL: 'cloudinary://123456:s3cr3t@demo-cloud' };
  const make = (extra: Record<string, string> = {}) => new CloudinaryStorage(loadConfig({ ...env, ...extra }));
  afterEach(() => vi.restoreAllMocks());

  it('signs private delivery URLs (authenticated type, signature segment, format from the key)', async () => {
    const url = new URL(await make().signedUrl('users/u1/meals/m1.jpg'));
    expect(url.origin).toBe('https://res.cloudinary.com');
    expect(url.pathname).toMatch(/^\/demo-cloud\/image\/authenticated\/s--[A-Za-z0-9_-]{8}--\/v1\/users\/u1\/meals\/m1\.jpg$/);
    expect(url.search).toBe('');
    // A different object gets a different signature, so one link cannot be reused for another photo.
    const other = new URL(await make().signedUrl('users/u1/meals/m2.jpg'));
    expect(other.pathname.split('/')[4]).not.toBe(url.pathname.split('/')[4]);
  });

  it('puts everything under CLOUDINARY_FOLDER', async () => {
    const url = new URL(await make({ CLOUDINARY_FOLDER: '/calcam/prod/' }).signedUrl('users/u1/meals/m1.jpg'));
    expect(url.pathname.endsWith('/v1/calcam/prod/users/u1/meals/m1.jpg')).toBe(true);
  });

  it('issues expiring token links when token authentication is configured', async () => {
    const storage = make({ CLOUDINARY_AUTH_TOKEN_KEY: '00112233445566778899aabbccddeeff' });
    const url = new URL(await storage.signedUrl('users/u1/meals/m1.jpg', 900));
    const token = url.searchParams.get('__cld_token__') ?? '';
    const exp = Number(/exp=(\d+)/.exec(token)?.[1]);
    expect(Math.abs(exp - (Date.now() / 1000 + 900))).toBeLessThan(10);
    expect(token).toMatch(/hmac=[0-9a-f]{64}/);
    expect(url.pathname).not.toMatch(/s--/); // a token replaces the plain signature
  });

  it('refuses keys that climb out of the folder', async () => {
    await expect(make().put('users/../../secret.jpg', Buffer.from('x'), 'image/jpeg')).rejects.toThrow('Invalid storage key');
    await expect(make().signedUrl('../x.jpg')).rejects.toThrow('Invalid storage key');
  });

  it('uploads privately, by public id, replacing any previous version', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((options: Record<string, unknown>, cb: (e?: unknown, r?: unknown) => void) => {
      calls.push(options);
      return new Writable({
        write: (_c, _e, done) => done(),
        final: (done) => {
          done();
          cb(undefined, { public_id: options['public_id'] });
        },
      });
    }) as never);
    await make({ CLOUDINARY_FOLDER: 'calcam' }).put('users/u1/meals/m1.jpg', Buffer.from('JPEG'), 'image/jpeg');
    expect(calls[0]).toMatchObject({
      public_id: 'calcam/users/u1/meals/m1',
      type: 'authenticated',
      resource_type: 'image',
      overwrite: true,
      invalidate: true,
      cloud_name: 'demo-cloud',
      api_key: '123456',
    });
  });

  it('turns SDK error objects into real Errors', async () => {
    vi.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((_o: unknown, cb: (e?: unknown) => void) =>
      new Writable({
        write: (_c, _e, done) => done(),
        final: (done) => {
          done();
          cb({ message: 'Invalid API key', http_code: 401 });
        },
      })) as never);
    await expect(make().put('users/u1/meals/m1.jpg', Buffer.from('x'), 'image/jpeg')).rejects.toThrow('Cloudinary upload failed (HTTP 401): Invalid API key');
  });

  it('downloads through a signed URL, and reports a failed download', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(Buffer.from('BYTES')));
    expect((await make().get('users/u1/meals/m1.jpg')).toString()).toBe('BYTES');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/image/authenticated/');
    fetchSpy.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(make().get('users/u1/meals/gone.jpg')).rejects.toThrow('HTTP 404');
  });

  it('deletes by prefix until Cloudinary reports nothing is left, without matching sibling users', async () => {
    const del = vi
      .spyOn(cloudinary.api, 'delete_resources_by_prefix')
      .mockResolvedValueOnce({ deleted: {}, partial: true } as never)
      .mockResolvedValueOnce({ deleted: {}, partial: false } as never);
    vi.spyOn(cloudinary.api, 'delete_folder').mockResolvedValue({} as never);
    await make({ CLOUDINARY_FOLDER: 'calcam' }).deletePrefix('users/u1/');
    expect(del).toHaveBeenCalledTimes(2);
    expect(del.mock.calls[0]?.[0]).toBe('calcam/users/u1/'); // trailing slash: "users/u1/" must not match "users/u10/"
    expect(del.mock.calls[0]?.[1]).toMatchObject({ type: 'authenticated', resource_type: 'image' });
  });

  it('caches a successful ping so health checks do not use up API quota, but reports failures', async () => {
    const ping = vi.spyOn(cloudinary.api, 'ping').mockResolvedValue({ status: 'OK' } as never);
    const storage = make();
    await storage.ping();
    await storage.ping();
    expect(ping).toHaveBeenCalledTimes(1);

    ping.mockReset().mockRejectedValue({ message: 'Unauthorized', http_code: 401 });
    await expect(make().ping()).rejects.toThrow('Cloudinary ping failed (HTTP 401)');
  });
});
