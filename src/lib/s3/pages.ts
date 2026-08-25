import "server-only";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client, getBucket } from "./client";

/**
 * Raw page storage.
 *
 * Every fetched page is written here byte-for-byte before anything tries to
 * understand it. This is the single most useful decision in the pipeline: when
 * a portal redesigns and the parser breaks — and it will — the fix is a new
 * parser run over pages we already hold, not a re-crawl of thirteen sites.
 * It also means a parser bug found in November can be corrected across
 * September's data.
 */

/** `pages/{source}/{yyyy-mm-dd}/{externalId}.html` — sorts usefully in a bucket listing. */
export function pageKey(sourceKey: string, externalId: string, fetchedAt = new Date()): string {
  const day = fetchedAt.toISOString().slice(0, 10);
  // External ids come from URLs and are mostly clean, but a portal is free to
  // put a slash or a query character in one. Encode rather than trust.
  const safeId = encodeURIComponent(externalId);
  return `pages/${sourceKey}/${day}/${safeId}.html`;
}

export async function putPage(key: string, body: string): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: body,
      ContentType: "text/html; charset=utf-8",
    }),
  );
}

/**
 * Read a stored page back.
 *
 * `maxBytes` truncates rather than throwing. The Vault project had this the
 * other way round — the reader threw when a file exceeded the caller's cap, so
 * every large file silently became a "read failed" placeholder and nobody
 * noticed for weeks. Truncation is the honest failure here: you get most of the
 * page and the caller can tell.
 */
export async function getPage(key: string, maxBytes = 8 * 1024 * 1024): Promise<string> {
  const res = await getS3Client().send(
    new GetObjectCommand({ Bucket: getBucket(), Key: key }),
  );
  if (!res.Body) throw new Error(`S3 object ${key} has no body`);

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk);
    if (total + buf.length > maxBytes) {
      chunks.push(buf.subarray(0, maxBytes - total));
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }
  return Buffer.concat(chunks).toString("utf8");
}
