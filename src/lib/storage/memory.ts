import type { ObjectStorage } from './index';

/** In-process storage for tests. Not shared between the API and worker processes. */
export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }

  async get(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`Object not found: ${key}`);
    return o.body;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.objects.keys()]) if (key.startsWith(prefix)) this.objects.delete(key);
  }

  async signedUrl(key: string, ttlSeconds = 900): Promise<string> {
    return `memory://${key}?expires=${Math.floor(Date.now() / 1000) + ttlSeconds}`;
  }

  async ping(): Promise<void> {}
}
