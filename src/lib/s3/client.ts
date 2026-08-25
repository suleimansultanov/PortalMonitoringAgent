import "server-only";
import { S3Client } from "@aws-sdk/client-s3";

declare global {
  // eslint-disable-next-line no-var
  var __pma_s3: S3Client | undefined;
}

export function getS3Client(): S3Client {
  if (globalThis.__pma_s3) return globalThis.__pma_s3;

  const endpoint = process.env.S3_ENDPOINT;
  const accessKey = process.env.S3_ACCESS_KEY;
  const secretKey = process.env.S3_SECRET_KEY;
  const region = process.env.S3_REGION ?? "auto";

  if (!endpoint || !accessKey || !secretKey) {
    throw new Error("S3 credentials missing — set S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY");
  }

  const client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
    /**
     * Bounded timeouts, not the SDK defaults. Without them a stalled connection
     * hangs the request forever; inside a serverless handler that means the
     * function is SIGKILLed at maxDuration, skipping every catch and cleanup —
     * which is how a run ends up wedged in "running" with no error recorded.
     */
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 20_000 },
    maxAttempts: 3,
  });

  globalThis.__pma_s3 = client;
  return client;
}

export function getBucket(): string {
  const b = process.env.S3_BUCKET;
  if (!b) throw new Error("S3_BUCKET is not set");
  return b;
}
