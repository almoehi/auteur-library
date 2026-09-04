/** The hosted harness: Hannes's Modal deployment, spoken to the way it wants.
 *
 *  The local harness is one process at a fixed address, and the studio talks to
 *  it with `POST {harness}/workspaces/{id}/api/{op}` for everything, including
 *  opening. The hosted one is three endpoints and a different first step: you
 *  hand it the whole workspace YAML (`submit`), get a job id back, and the
 *  workspace opens by itself inside a fresh sandbox that takes a while to exist.
 *  Once it does, the sandbox's own agent is reachable through a pass-through
 *  proxy at `{proxy}/{sandboxId}/workspaces/{id}/...` — which is the same path
 *  the studio already uses, with a per-job prefix in front and two auth headers.
 *
 *  So this module owns exactly the parts that differ: the three calls, the
 *  bookkeeping that maps a workspace id to its job and sandbox (nothing else
 *  in the studio has any reason to know a sandbox exists), and a memory of the
 *  finished run's result, because the sandbox goes away when the run ends and
 *  the finished clips are then only reachable by the presigned urls the result
 *  carries. Everything above this sits behind `harnessTarget()` in $lib/harness.
 *
 *  Endpoint urls follow Modal's documented convention, confirmed against the
 *  client Hannes shipped: https://{workspace}--{app}-{function}.modal.run, with
 *  underscores in the function name turned into dashes (so `_sandbox_proxy_asgi`
 *  produces the doubled `--sandbox-proxy-asgi`).
 */
import { env } from '$env/dynamic/private';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_APP = 'auteur-harness-modal';

/** Every call to a Modal web endpoint — none of them should take long, and the
 *  one that hangs must not take the launch with it. */
const CALL_TIMEOUT_MS = 30_000;

/** A status poll is a round trip to Modal; the page polls us every few seconds,
 *  and every one of those turning into a Modal call would be silly. */
const STATUS_MIN_INTERVAL_MS = 3_000;

/** After submit, how long the launch waits for the sandbox to exist before
 *  handing the wait over to the page's own polling. Cold sandboxes were
 *  measured in the tens of seconds; this is generous, not tight. */
const SANDBOX_WAIT_MS = 240_000;
const SANDBOX_WAIT_STEP_MS = 5_000;

/** The API insists on a callback url and validates it against SSRF, but the
 *  run never depends on it being reachable (best-effort push per poll). The
 *  same public sink the shipped client uses. */
const CALLBACK_SINK = 'https://example.com/modal-harness-client-sink';

export function hostedHarness(): boolean {
	return !!(env.AUTEUR_MODAL_KEY && env.AUTEUR_MODAL_SECRET && env.AUTEUR_MODAL_WORKSPACE);
}

function fnUrl(fn: string): string {
	const ws = env.AUTEUR_MODAL_WORKSPACE ?? '';
	const app = env.AUTEUR_MODAL_APP || DEFAULT_APP;
	return `https://${ws}--${app}-${fn.replace(/_/g, '-')}.modal.run`;
}

export function modalHeaders(): Record<string, string> {
	return { 'Modal-Key': env.AUTEUR_MODAL_KEY ?? '', 'Modal-Secret': env.AUTEUR_MODAL_SECRET ?? '' };
}

/** The proxy base for one sandbox. Append `/workspaces/{id}/...` exactly as
 *  for the local harness. */
export function proxyBase(sandboxId: string): string {
	return `${fnUrl('_sandbox_proxy_asgi')}/${encodeURIComponent(sandboxId)}`;
}

// ─── wire types, field-for-field with Hannes's schemas.py ─────────────────────

export type TaskStatus = 'pending' | 'ready' | 'running' | 'success' | 'failed' | 'permanently-failed';

export interface RunResult {
	request_id: string;
	status: 'running' | 'success' | 'failed';
	tasks: { key: string; status: TaskStatus; failure_reason?: string | null }[];
	artifacts: {
		artifactId: string;
		files: { fileKey: string; url?: string | null; error?: string | null }[];
		error?: string | null;
	}[];
	error?: string | null;
}

interface StatusResult {
	job_id: string;
	done: boolean;
	result?: RunResult | null;
	sandbox_id?: string | null;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { ...modalHeaders(), 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`modal ${url.split('.modal.run')[0].split('--').pop()} → ${res.status}: ${text.slice(0, 300)}`);
	return JSON.parse(text) as T;
}

// ─── the job book ─────────────────────────────────────────────────────────────

export interface JobRecord {
	jobId: string;
	submittedAt: number;
	sandboxId: string | null;
	done: boolean;
	result: RunResult | null;
	/** When status was last asked; the poll is rate-limited off this. */
	checkedAt: number;
}

const DIR = join(homedir(), 'auteur', 'studio-library');
const FILE = join(DIR, 'jobs.json');

function readBook(): Record<string, JobRecord> {
	if (!existsSync(FILE)) return {};
	try {
		return JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, JobRecord>;
	} catch {
		return {};
	}
}

function writeBook(book: Record<string, JobRecord>): void {
	mkdirSync(DIR, { recursive: true });
	const tmp = `${FILE}.tmp`;
	writeFileSync(tmp, JSON.stringify(book, null, 1));
	renameSync(tmp, FILE);
}

export function jobFor(workspaceId: string): JobRecord | null {
	return readBook()[workspaceId] ?? null;
}

function update(workspaceId: string, patch: Partial<JobRecord>): JobRecord {
	const book = readBook();
	const next = { ...(book[workspaceId] as JobRecord), ...patch };
	book[workspaceId] = next;
	writeBook(book);
	return next;
}

/** Ask Modal where the job stands, at most once per STATUS_MIN_INTERVAL_MS
 *  unless forced. Caches sandbox id and, once done, the result. */
export async function refreshJob(workspaceId: string, force = false): Promise<JobRecord | null> {
	const job = jobFor(workspaceId);
	if (!job) return null;
	if (job.done && job.result) return job;
	if (!force && Date.now() - job.checkedAt < STATUS_MIN_INTERVAL_MS) return job;
	const s = await postJson<StatusResult>(fnUrl('status'), { job_id: job.jobId });
	return update(workspaceId, {
		checkedAt: Date.now(),
		sandboxId: s.sandbox_id ?? job.sandboxId ?? null,
		done: !!s.done,
		result: s.result ?? job.result ?? null
	});
}

/** The sandbox id for a workspace, or null while it does not exist yet (or the
 *  workspace was never submitted here). */
export async function sandboxFor(workspaceId: string): Promise<string | null> {
	const job = await refreshJob(workspaceId);
	return job?.sandboxId ?? null;
}

/** The presigned url of one finished file, if the run is over and named it. */
export function presignedFor(workspaceId: string, artifactId: string, fileKey: string): string | null {
	const job = jobFor(workspaceId);
	const art = job?.result?.artifacts.find((a) => a.artifactId === artifactId);
	const f = art?.files.find((x) => x.fileKey === fileKey);
	return f?.url ?? null;
}

// ─── opening ──────────────────────────────────────────────────────────────────

/** Submit the YAML, remember the job, and wait — bounded — for its sandbox.
 *
 *  Not waiting at all would be simpler, but the launch's next step loads the
 *  operator's library into the workspace, and that has to reach a live agent.
 *  Waiting forever is the local harness's mistake (an open that hangs holds the
 *  button). So: wait up to SANDBOX_WAIT_MS, then return either way; a sandbox
 *  that is late is handed to the page's polling, which knows how to show a
 *  workspace that is still starting. */
export async function openHosted(
	workspaceId: string,
	yaml: string
): Promise<{ ok: true; sandboxId: string | null } | { ok: false; error: string }> {
	let jobId: string;
	try {
		const r = await postJson<{ job_id: string }>(fnUrl('submit'), {
			workspace_yaml: yaml,
			status_callback_url: CALLBACK_SINK,
			poll_interval_sec: 12
		});
		jobId = r.job_id;
	} catch (e) {
		return { ok: false, error: `the hosted harness refused the workspace: ${String(e).slice(0, 400)}` };
	}
	const book = readBook();
	book[workspaceId] = { jobId, submittedAt: Date.now(), sandboxId: null, done: false, result: null, checkedAt: 0 };
	writeBook(book);
	console.log(`=== auteur: submitted ${workspaceId} to the hosted harness as job ${jobId} ===`);

	const deadline = Date.now() + SANDBOX_WAIT_MS;
	while (Date.now() < deadline) {
		try {
			const job = await refreshJob(workspaceId, true);
			if (job?.sandboxId) {
				console.log(`=== auteur: ${workspaceId} sandbox ${job.sandboxId} up after ${Math.round((Date.now() - job.submittedAt) / 1000)}s ===`);
				return { ok: true, sandboxId: job.sandboxId };
			}
			if (job?.done) {
				// Finished before a sandbox was ever reported: the run failed on
				// admission, and the result says why.
				const why = job.result?.error || job.result?.tasks.find((t) => t.failure_reason)?.failure_reason || 'the run ended before its sandbox started';
				return { ok: false, error: why };
			}
		} catch (e) {
			// A single failed status poll is not a failed launch; the next one may answer.
			console.warn(`=== auteur: status poll for ${workspaceId} failed: ${String(e).slice(0, 200)}`);
		}
		await new Promise((r) => setTimeout(r, SANDBOX_WAIT_STEP_MS));
	}
	console.warn(`=== auteur: ${workspaceId} has no sandbox after ${SANDBOX_WAIT_MS / 1000}s; the page will keep polling ===`);
	return { ok: true, sandboxId: null };
}
