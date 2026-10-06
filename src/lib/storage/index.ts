import type { Config } from '../../config/env';
import { FsStorage } from './fs';
import { MemoryStorage } from './memory';
import { S3Storage } from './s3';

export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Removes every object under the prefix. Used by account deletion. */
  deletePrefix(prefix: string): Promise<void>;
  /** Time-limited read URL. Objects are private; there is no public access. */
  signedUrl(key: string, ttlSeconds?: number): Promise<string>;
  /** Throws if the backing store is unreachable (used by /ready). */
  ping(): Promise<void>;
}

export const mealImageKey = (userId: string, mealId: string) => `users/${userId}/meals/${mealId}.jpg`;
export const mealThumbKey = (userId: string, mealId: string) => `users/${userId}/meals/${mealId}_thumb.jpg`;
export const userPrefix = (userId: string) => `users/${userId}/`;

export function createStorage(config: Config): ObjectStorage {
  switch (config.storage.driver) {
    case 's3':
      return new S3Storage(config);
    case 'fs':
      return new FsStorage(config);
    case 'memory':
      return new MemoryStorage();
  }
}
