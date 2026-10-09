import { v2 as cloudinary } from 'cloudinary';
import type { Config } from '../../config/env';
import type { ObjectStorage } from './index';

/** How long a successful /ready probe is trusted, so frequent health checks do not spend Admin API quota. */
const PING_CACHE_MS = 30_000;
/** Safety stop for the delete-by-prefix loop (each call removes up to 1000 files). */
const MAX_DELETE_PAGES = 200;

/**
 * Cloudinary storage. Every photo is uploaded with `type: authenticated`, which makes it private: delivery needs a
 * signed URL, and the original cannot be fetched by guessing its public id.
 *
 * Keys keep the same shape as the other drivers ("users/<userId>/meals/<mealId>.jpg"). The extension becomes the
 * delivery format and the rest is the Cloudinary public id, optionally under CLOUDINARY_FOLDER.
 *
 * signedUrl():
 *  - with CLOUDINARY_AUTH_TOKEN_KEY (token-based authentication, which Cloudinary enables per account) the link
 *    carries a token that expires after the TTL, like the 15 minute S3 links;
 *  - without it the link carries a URL signature, which proves the URL was issued by this backend but does not expire.
 */
export class CloudinaryStorage implements ObjectStorage {
  private readonly creds: { cloud_name: string; api_key: string; api_secret: string };
  private readonly folder: string;
  private readonly tokenKey?: string;
  private readonly ttl: number;
  private pingedAt = 0;

  constructor(config: Config) {
    const c = config.storage.cloudinary;
    if (!c) throw new Error('CloudinaryStorage needs CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET');
    this.creds = { cloud_name: c.cloudName, api_key: c.apiKey, api_secret: c.apiSecret };
    this.folder = c.folder.replace(/^\/+|\/+$/g, '');
    this.tokenKey = c.authTokenKey;
    this.ttl = config.storage.signedUrlTtlSeconds;
  }

  /** Puts the key under CLOUDINARY_FOLDER and refuses path tricks. */
  private qualify(path: string): string {
    if (path.split('/').some((part) => part === '..' || part === '.')) throw new Error(`Invalid storage key: ${path}`);
    return this.folder ? `${this.folder}/${path}` : path;
  }

  /** "users/u1/meals/m1.jpg" -> { publicId: "<folder>/users/u1/meals/m1", format: "jpg" } */
  private locate(key: string): { publicId: string; format?: string } {
    const m = key.match(/^(.*)\.([A-Za-z0-9]+)$/);
    const format = m ? (m[2] as string).toLowerCase() : undefined;
    return { publicId: this.qualify(m ? (m[1] as string) : key), ...(format ? { format } : {}) };
  }

  private async call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // The SDK rejects with plain objects ({ message, http_code }), which carry no stack and log as "[object Object]".
      if (err instanceof Error) throw err;
      const e = err as { message?: string; http_code?: number };
      throw new Error(`Cloudinary ${operation} failed${e.http_code ? ` (HTTP ${e.http_code})` : ''}: ${e.message ?? String(err)}`);
    }
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<void> {
    const { publicId } = this.locate(key);
    await this.call('upload', () =>
      new Promise<void>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            ...this.creds,
            public_id: publicId,
            resource_type: 'image',
            type: 'authenticated',
            overwrite: true,
            invalidate: true,
            unique_filename: false,
            use_filename: false,
          },
          (error, result) => (error || !result ? reject(error ?? new Error('empty upload response')) : resolve()),
        );
        stream.end(body);
      }),
    );
  }

  /** The original bytes, fetched through a short-lived signed delivery URL. */
  async get(key: string): Promise<Buffer> {
    const url = this.deliveryUrl(key, Math.min(this.ttl, 300));
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Cloudinary download failed (HTTP ${res.status}) for ${key}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const { publicId } = this.locate(key);
    await this.call('delete', () =>
      cloudinary.uploader.destroy(publicId, { ...this.creds, resource_type: 'image', type: 'authenticated', invalidate: true }),
    );
  }

  async deletePrefix(prefix: string): Promise<void> {
    // Keep the trailing slash: "users/a/" must not match "users/ab/...".
    const publicPrefix = this.qualify(prefix);
    for (let page = 0; page < MAX_DELETE_PAGES; page++) {
      const result = await this.call('delete by prefix', () =>
        cloudinary.api.delete_resources_by_prefix(publicPrefix, { ...this.creds, resource_type: 'image', type: 'authenticated', invalidate: true }),
      );
      if (!result.partial) break;
    }
    // Remove the now-empty folder so account ids do not linger in the media library. Not worth failing a deletion over.
    await cloudinary.api.delete_folder(publicPrefix.replace(/\/$/, ''), this.creds).catch(() => undefined);
  }

  async signedUrl(key: string, ttlSeconds = this.ttl): Promise<string> {
    return this.deliveryUrl(key, ttlSeconds);
  }

  async ping(): Promise<void> {
    if (Date.now() - this.pingedAt < PING_CACHE_MS) return;
    await this.call('ping', () => cloudinary.api.ping(this.creds));
    this.pingedAt = Date.now();
  }

  private deliveryUrl(key: string, ttlSeconds: number): string {
    const { publicId, format } = this.locate(key);
    return cloudinary.url(publicId, {
      ...this.creds,
      resource_type: 'image',
      type: 'authenticated',
      ...(format ? { format } : {}),
      secure: true,
      sign_url: true,
      // The SDK would append "_a=<sdk version>" to the URL, which is noise in a link meant to be opaque.
      analytics: false,
      ...(this.tokenKey ? { auth_token: { key: this.tokenKey, duration: ttlSeconds } } : {}),
    });
  }
}
