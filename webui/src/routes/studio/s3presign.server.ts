/** Presigned S3 URLs, signed here rather than fetched from anywhere.
 *
 *  The Modal render worker is given a URL to PUT its output to and never sees an
 *  AWS credential — that is the whole design, and it is why the caller has to do
 *  the signing. The harness does this for its own renders; this is the same job
 *  for the renders that do not go through the harness.
 *
 *  SigV4 query-string signing, by hand, because pulling the AWS SDK in for two
 *  URLs would be a 20 MB dependency for eighty lines of well-specified HMAC. The
 *  spec is AWS's "Signature Version 4 signing process — query parameters".
 *
 *  Plain AWS S3 only. The bucket here is a real S3 bucket in us-west-2 with no
 *  custom endpoint, and virtual-hosted addressing is what that gets. A
 *  MinIO-style endpoint would need path-style addressing and a different host,
 *  which is a change worth making deliberately rather than by accident — so it
 *  throws rather than guessing.
 */
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ALGO = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

export interface S3Config {
	accessKey: string;
	secretKey: string;
	region: string;
	bucket: string;
}

function sha256Hex(data: string | Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Uint8Array | string, data: string): Buffer {
	return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC 3986 unreserved-only encoding. `encodeURIComponent` leaves `!'()*`
 *  unescaped and AWS wants them escaped; getting this wrong produces a signature
 *  that verifies for most keys and fails for the one with a bracket in it. */
function uriEncode(s: string): string {
	return encodeURIComponent(s).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);
}

/** A key is a path: each segment is encoded, the slashes are not. */
function encodeKey(key: string): string {
	return key.split('/').map(uriEncode).join('/');
}

function stamps(now: Date): { amzDate: string; dateStamp: string } {
	const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
	return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signingKey(cfg: S3Config, dateStamp: string): Buffer {
	const kDate = hmac(`AWS4${cfg.secretKey}`, dateStamp);
	const kRegion = hmac(kDate, cfg.region);
	const kService = hmac(kRegion, SERVICE);
	return hmac(kService, 'aws4_request');
}

/** One presigned URL for one method.
 *
 *  `UNSIGNED-PAYLOAD` rather than a body hash: the worker uploads bytes we have
 *  never seen, so there is nothing to hash at signing time. It is the documented
 *  value for exactly this case.
 */
export function presign(
	cfg: S3Config,
	method: 'PUT' | 'GET',
	key: string,
	expiresSec: number,
	now: Date = new Date()
): string {
	if (!cfg.accessKey || !cfg.secretKey || !cfg.region || !cfg.bucket) {
		throw new Error('S3 is not configured — AWS_ACCESS_KEY, AWS_SECRET_KEY, AWS_REGION and S3_BUCKET are all required');
	}
	const { amzDate, dateStamp } = stamps(now);
	const host = `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
	const scope = `${dateStamp}/${cfg.region}/${SERVICE}/aws4_request`;

	// Sorted by key, as the canonical form requires. Written out rather than
	// built from an object so the order is visible and cannot drift.
	const query = [
		['X-Amz-Algorithm', ALGO],
		['X-Amz-Credential', `${cfg.accessKey}/${scope}`],
		['X-Amz-Date', amzDate],
		['X-Amz-Expires', String(Math.max(1, Math.floor(expiresSec)))],
		['X-Amz-SignedHeaders', 'host']
	]
		.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
		.join('&');

	const canonical = [
		method,
		`/${encodeKey(key)}`,
		query,
		`host:${host}\n`,
		'host',
		'UNSIGNED-PAYLOAD'
	].join('\n');

	const toSign = [ALGO, amzDate, scope, sha256Hex(canonical)].join('\n');
	const signature = hmac(signingKey(cfg, dateStamp), toSign).toString('hex');

	return `https://${host}/${encodeKey(key)}?${query}&X-Amz-Signature=${signature}`;
}

/** A PUT the worker uploads to, and a GET we read back — the same object, two
 *  signatures, because a presigned URL is signed per method. */
export function slotUrls(
	cfg: S3Config,
	key: string,
	expiresSec: number
): { put_url: string; get_url: string } {
	// One clock for both, so the pair expires together rather than a second apart.
	const now = new Date();
	return {
		put_url: presign(cfg, 'PUT', key, expiresSec, now),
		get_url: presign(cfg, 'GET', key, expiresSec, now)
	};
}

/** The harness's env file, which is where the AWS credentials already live.
 *
 *  Read per call so a rotation takes effect without restarting this app, and
 *  kept here rather than copied into each caller because a second reader of a
 *  secret is a second thing to leak and a second thing to forget to update.
 */
export function harnessEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	const p = join(homedir(), 'auteur', '.env');
	if (!existsSync(p)) return out;
	for (const line of readFileSync(p, 'utf8').split('\n')) {
		const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
		if (m) out[m[1]] = m[2];
	}
	return out;
}

/** The bucket config, or null when it is not configured. */
export function s3FromEnv(e: Record<string, string> = harnessEnv()): S3Config | null {
	const cfg = {
		accessKey: e.AWS_ACCESS_KEY ?? '',
		secretKey: e.AWS_SECRET_KEY ?? '',
		region: e.AWS_REGION ?? '',
		bucket: e.S3_BUCKET ?? ''
	};
	return cfg.accessKey && cfg.secretKey && cfg.region && cfg.bucket ? cfg : null;
}

/** How long a reference image stays readable.
 *
 *  Long enough to outlive the render that uses it and the harness's retries —
 *  an expired link fails on the GPU, minutes in, which is the expensive place to
 *  find out. Short enough that a leaked URL is not a permanent one. */
export const REF_URL_TTL_SEC = 6 * 60 * 60;

/** Put bytes in the bucket and hand back a URL a cloud GPU can read.
 *
 *  This exists because the render worker runs on Modal and our own server does
 *  not have an address it can reach. The harness is explicit about it — it
 *  refuses `localhost`, `host.docker.internal` and every RFC-1918 range at
 *  submission time — so a reference image has to be somewhere public before it
 *  can be a reference at all.
 *
 *  No content-type header: the signature covers `host` only, the worker saves
 *  the body to a path and re-uploads it to ComfyUI, and the filename it ends up
 *  with comes from the URL's extension rather than from any metadata. One less
 *  thing to get wrong.
 */
export async function putObject(
	cfg: S3Config,
	key: string,
	bytes: Uint8Array,
	fetchFn: typeof globalThis.fetch = fetch,
	expiresSec: number = REF_URL_TTL_SEC
): Promise<string> {
	const { put_url, get_url } = slotUrls(cfg, key, expiresSec);
	// Copied out to its own ArrayBuffer rather than sent as the view we were
	// given. Node's Buffer is a view onto a shared pooled allocation, so handing
	// the underlying buffer straight to fetch can send neighbouring bytes as well
	// as ours — and a reference image with someone else's memory stapled to it is
	// not a decodable PNG. Slicing by offset and length takes exactly this file.
	const body = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength
	) as ArrayBuffer;
	const res = await fetchFn(put_url, { method: 'PUT', body });
	if (!res.ok) {
		throw new Error(`S3 PUT of ${key} answered ${res.status} ${(await res.text()).slice(0, 200)}`);
	}
	return get_url;
}
