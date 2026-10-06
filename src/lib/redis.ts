import IORedis from 'ioredis';

/** Regular connection for the cache and rate limiter. */
export const createRedis = (url: string) => new IORedis(url, { lazyConnect: false, enableOfflineQueue: true });

/** BullMQ requires maxRetriesPerRequest: null on blocking connections. */
export const createQueueRedis = (url: string) => new IORedis(url, { maxRetriesPerRequest: null });
