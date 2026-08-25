/** Renders that skip the harness and go straight to the GPU.
 *
 *  Measured, a character preview costs about 150 seconds of which 25 is the
 *  picture. Roughly a hundred of the rest is the harness opening a workspace,
 *  dispatching an agent, and then Modal running a separate model-verification
 *  job whose container exits before the render's container starts — so the wait
 *  is paid twice for work that, for this one render, never varies.
 *
 *  It never varies because a character preview is the one render in this app
 *  with nothing to decide: three fixed models that are already on the volume, a
 *  graph we generate ourselves, no adapters, no per-clip stack. That is why this
 *  bypass is reasonable here and was rejected for clips, where the harness's
 *  model provisioning and retries earn their keep.
 *
 *  What we give up, stated plainly so nobody has to rediscover it:
 *    - model provisioning. A model missing from the volume is a failed render,
 *      not a download. Fine for three files that have been there since August.
 *    - retries and the GPU downgrade ladder.
 *    - the harness's record of the run. Nothing appears in its workspace list.
 *
 *  The contract below was established by probing the live endpoint, not by
 *  reading alone. Two findings are load-bearing and easy to get wrong:
 *
 *    1. `status: "COMPLETE"` does NOT mean success. A render that failed inside
 *       ComfyUI also completes, with `output.ok === false`. Checking the status
 *       alone reads a failure as a success.
 *    2. Output slots are matched to the graph's outputs BY POSITION, not by node
 *       id. One SaveImage means exactly one slot, and it is index 0.
 */
import { slotUrls, type S3Config } from './s3presign.server';

/** Modal builds an endpoint name from the workspace slug, the GPU tier and the
 *  runtime versions. These must match a deployed app or the submit succeeds and
 *  the job fails later — the endpoint URL is constructed, never probed. */
export interface ModalTarget {
	workspace: string;
	gpu: 'l40s' | 'a100' | 'h100';
	cuda: string;
	comfy: string;
}

function appName(t: ModalTarget): string {
	return `comfy-compute-${t.gpu}-cu${t.cuda}-${t.comfy.replaceAll('.', '-')}`;
}

function submitUrl(t: ModalTarget): string {
	return `https://${t.workspace}--${appName(t)}-submit.modal.run`;
}

function statusUrl(t: ModalTarget): string {
	return submitUrl(t).replace('-submit.modal.run', '-status.modal.run');
}

export interface OutputSlot {
	/** The filename the worker reports it under. */
	name: string;
	/** The graph node that produces it. Informational — the worker matches slots
	 *  to outputs by position — but wrong values make a failure unreadable. */
	node_id: string;
	put_url: string;
	get_url: string;
}

export interface DirectRender {
	renderId: string;
	/** The ComfyUI API-format graph, already resolved. */
	workflow: unknown;
	target: ModalTarget;
	s3: S3Config;
	/** One per graph output, in graph output order. */
	outputs: { name: string; nodeId: string; key: string }[];
	timeoutSec?: number;
}

export type DirectResult =
	| { ok: true; files: { name: string; url: string }[]; elapsedSec?: number }
	| { ok: false; error: string; code?: string; elapsedSec?: number };

/** Long enough for a cold container plus a render, short enough that a hung job
 *  gives up rather than holding a page open forever. */
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
/** The job takes minutes and the status endpoint is a plain function call;
 *  hammering it buys nothing. */
const POLL_EVERY_MS = 3_000;
/** The signed URLs have to outlive the render they belong to, with room for a
 *  cold start and a queue. */
const URL_TTL_SEC = 3 * 60 * 60;

export async function renderDirect(
	req: DirectRender,
	fetch: typeof globalThis.fetch
): Promise<DirectResult> {
	const slots: OutputSlot[] = req.outputs.map((o) => ({
		name: o.name,
		node_id: o.nodeId,
		...slotUrls(req.s3, o.key, URL_TTL_SEC)
	}));

	const body = {
		command: 'run_workflow',
		render_id: req.renderId,
		workflow: req.workflow,
		...(req.timeoutSec !== undefined ? { timeout_sec: req.timeoutSec } : {}),
		s3: {
			bucket: req.s3.bucket,
			region: req.s3.region,
			endpoint_url: null,
			output_slots: slots
		}
	};

	let jobId: string;
	try {
		const res = await fetch(submitUrl(req.target), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) return { ok: false, error: `submit returned ${res.status}` };
		const d = (await res.json()) as { job_id?: string };
		if (!d.job_id) return { ok: false, error: 'submit answered without a job id' };
		jobId = d.job_id;
	} catch (e) {
		return { ok: false, error: `could not reach the renderer — ${e}` };
	}

	const deadline = Date.now() + POLL_TIMEOUT_MS;
	const url = `${statusUrl(req.target)}?job_id=${encodeURIComponent(jobId)}`;
	for (;;) {
		if (Date.now() > deadline) {
			return { ok: false, error: `the render did not finish within ${POLL_TIMEOUT_MS / 60000} minutes` };
		}
		await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
		let d: { status?: string; error?: string; output?: Record<string, unknown> };
		try {
			const res = await fetch(url, { method: 'GET' });
			if (!res.ok) continue; // a blip in the status endpoint is not a failed render
			d = (await res.json()) as typeof d;
		} catch {
			continue;
		}

		// Modal-level failure: the job never got to run properly.
		if (d.status === 'FAILED') {
			return { ok: false, error: String(d.error ?? 'the render job failed') };
		}
		if (d.status !== 'COMPLETE') continue; // RUNNING, or queued and unnamed

		const out = (d.output ?? {}) as {
			ok?: boolean;
			error?: string;
			error_code?: string;
			elapsed_seconds?: number;
			outputs?: { name?: string; url?: string; get_url?: string }[];
			files?: { name?: string; url?: string; get_url?: string }[];
		};
		// The trap: COMPLETE is about the job, not the render.
		if (out.ok === false) {
			return {
				ok: false,
				error: String(out.error ?? 'the render failed'),
				code: out.error_code,
				elapsedSec: out.elapsed_seconds
			};
		}

		// The worker echoes the slots back; whichever key it uses, the URL we
		// signed is the one we already hold, so fall back to that rather than
		// depending on the response shape.
		const echoed = out.outputs ?? out.files ?? [];
		const files = slots.map((s, i) => {
			const e = echoed[i] as { name?: string; url?: string; get_url?: string } | undefined;
			return { name: e?.name ?? s.name, url: e?.get_url ?? e?.url ?? s.get_url };
		});
		return { ok: true, files, elapsedSec: out.elapsed_seconds };
	}
}
