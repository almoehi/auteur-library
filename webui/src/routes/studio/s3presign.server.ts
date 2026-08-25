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
