/** The one place that knows how to talk to the harness from the server.
 *
 *  Every call it exposes is workspace-scoped and side-effecting, which is why
 *  none of them are reachable through the read-only proxy at /studio/api/harness.
 */
import { harnessPost } from '$lib/harness';
import { listSkills, listWorkflows } from './library.server';

/** The harness answers some endpoints with an object and some with that same
 *  object JSON-encoded inside a string. Unwrap one level at a time so a plain
 *  prose error survives readable rather than becoming "[object Object]". */
export function unwrap(text: string): unknown {
	try {
		const once: unknown = JSON.parse(text);
		if (typeof once !== 'string') return once;
		try {
			return JSON.parse(once);
		} catch {
			return once;
		}
	} catch {
		return text;
	}
}

/** One library or reference call. None of these should take a minute; one
 *  that does is a wedged harness, and without this it held the launch endpoint
 *  — and the button above it — for ever. */
const CALL_TIMEOUT_MS = 60_000;

async function call(workspaceId: string, op: string, req: unknown) {
	const res = await harnessPost(workspaceId, op, { req }, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
	const text = await res.text();
	return { ok: res.ok, status: res.status, data: unwrap(text), text };
}

export interface LoadReport {
	workflows: { name: string; ok: boolean; detail?: string }[];
	skills: { name: string; ok: boolean; detail?: string }[];
}

/** Push the enabled library entries into a freshly opened workspace.
 *
 *  Timing matters and is the reason this is not "fire and forget": the harness
 *  gives an agent its workflow tools when a task is created, so anything loaded
 *  after the planner has already scheduled the shoot tasks will not be visible
 *  to them. Opening dispatches the planner immediately, and the planner takes
 *  minutes — so loading here, right after open and before the caller starts
 *  polling, lands well inside that window.
 *
 *  A failure is reported, never thrown. The built-in workflows are declared in
 *  the YAML and work regardless; losing a user workflow should cost you that
 *  workflow, not the production.
 */
export async function loadLibraryInto(workspaceId: string): Promise<LoadReport> {
	const report: LoadReport = { workflows: [], skills: [] };

	for (const w of listWorkflows().filter((x) => x.enabled)) {
		try {
			const r = await call(workspaceId, 'load-user-workflow', {
				name: w.name,
				jsonContent: w.jsonContent,
				...(w.yamlContent ? { yamlContent: w.yamlContent } : {}),
				...(w.description ? { description: w.description } : {}),
				...(w.lazy ? { lazy: true } : {}),
				...(w.provider ? { provider: w.provider } : {})
			});
			const d = r.data as { error?: string } | string | undefined;
			const err = typeof d === 'string' ? '' : (d?.error ?? '');
			report.workflows.push(
				r.ok && !err
					? { name: w.name, ok: true }
					: { name: w.name, ok: false, detail: err || r.text.slice(0, 200) }
			);
		} catch (e) {
			report.workflows.push({ name: w.name, ok: false, detail: String(e).slice(0, 200) });
		}
	}

	for (const s of listSkills().filter((x) => x.enabled)) {
		try {
			const r = await call(workspaceId, 'load-user-skill', {
				name: s.name,
				markdownContent: s.markdownContent
			});
			const d = r.data as { error?: string } | string | undefined;
			const err = typeof d === 'string' ? '' : (d?.error ?? '');
			report.skills.push(
				r.ok && !err
					? { name: s.name, ok: true }
					: { name: s.name, ok: false, detail: err || r.text.slice(0, 200) }
			);
		} catch (e) {
			report.skills.push({ name: s.name, ok: false, detail: String(e).slice(0, 200) });
		}
	}

	return report;
}

export interface UploadSlot {
	fileName: string;
	uploadUrl: string;
	getUrl: string;
	publicUrl?: string;
	key: string;
	expiresAt?: string;
}

export async function mintUploadUrls(
	workspaceId: string,
	fileNames: string[]
): Promise<{ slots: UploadSlot[]; error?: string }> {
	const r = await call(workspaceId, 'mint-upload-urls', { fileNames });
	if (!r.ok) return { slots: [], error: `mint-upload-urls ${r.status}: ${r.text.slice(0, 200)}` };
	const d = r.data as { slots?: UploadSlot[]; error?: string } | undefined;
	if (d?.error) return { slots: [], error: d.error };
	return { slots: Array.isArray(d?.slots) ? d.slots : [] };
}

export interface ImportFile {
	name: string;
	description: string;
	getUrl: string;
	size?: number;
}

export async function importUserArtifact(
	workspaceId: string,
	req: { key: string; title: string; description: string; files: ImportFile[] }
): Promise<{ artifactId?: string; error?: string }> {
	const r = await call(workspaceId, 'import-user-artifact', req);
	if (!r.ok) return { error: `import-user-artifact ${r.status}: ${r.text.slice(0, 300)}` };
	const d = r.data as { artifactId?: string; error?: string } | undefined;
	return { artifactId: d?.artifactId ?? undefined, error: d?.error ?? undefined };
}
