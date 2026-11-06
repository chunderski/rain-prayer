/** S3-compatible driver (AWS S3, MinIO). Presigned GETs; credentials only from the environment. */
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "../config.js";
import { assertKey, contentTypeOfKey, type ObjectStorage } from "./index.js";

export function createS3Storage(cfg: Config): ObjectStorage {
  const make = (endpoint: string) =>
    new S3Client({
      endpoint,
      region: cfg.S3_REGION,
      forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID!, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY! },
    });
  const client = make(cfg.S3_ENDPOINT!);
  const presigner = cfg.S3_PUBLIC_ENDPOINT ? make(cfg.S3_PUBLIC_ENDPOINT) : client;
  const Bucket = cfg.S3_BUCKET!;
  return {
    driver: "s3",
    async put(key, body, contentType) {
      assertKey(key);
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType, ...(cfg.S3_SSE ? { ServerSideEncryption: cfg.S3_SSE } : {}) }),
      );
    },
    async get(key) {
      assertKey(key);
      const r = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    },
    async delete(key) {
      assertKey(key);
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async signedUrl(key, ttlSeconds) {
      assertKey(key);
      const url = await getSignedUrl(
        presigner,
        new GetObjectCommand({ Bucket, Key: key, ResponseContentType: contentTypeOfKey(key), ResponseContentDisposition: "inline" }),
        { expiresIn: ttlSeconds },
      );
      return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
    },
  };
}
