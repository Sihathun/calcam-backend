import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../../config/env';
import type { ObjectStorage } from './index';

/** S3-compatible storage (AWS S3 in production, MinIO locally). */
export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  /** Signs against the public endpoint when it differs from the internal one (e.g. Docker network vs. localhost). */
  private readonly signer: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: Config) {
    const s = config.storage;
    const credentials =
      s.accessKeyId && s.secretAccessKey ? { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } : undefined;
    const base = { region: s.region, forcePathStyle: s.forcePathStyle, credentials };
    this.bucket = s.bucket;
    this.client = new S3Client({ ...base, endpoint: s.endpoint });
    this.signer = s.publicEndpoint ? new S3Client({ ...base, endpoint: s.publicEndpoint }) : this.client;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Server-side encryption at rest. Disabled by default because plain MinIO has no KMS configured.
        ServerSideEncryption: this.config.storage.sse,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty object: ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  async signedUrl(key: string, ttlSeconds = this.config.storage.signedUrlTtlSeconds): Promise<string> {
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}
