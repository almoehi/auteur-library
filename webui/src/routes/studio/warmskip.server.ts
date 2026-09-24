/** Whether a render that needs custom nodes may still skip preflight.
 *
 *  The worker installs and links customNodes only when preflight is on, and
 *  ComfyUI cannot load a node once it is running. So the first render on a cold
 *  container has to pay the checks. After that the container keeps the node
 *  loaded for as long as it stays warm, and a render with preflight off goes
 *  straight to the sampler — measured at 12–49 s saved per clip.
 *
 *  Warm is judged from the last such render's own completion: the container
 *  idles `scaledown_window` seconds after its last job, so a render launched
 *  within AUTEUR_WARM_SKIP_PREFLIGHT_SEC of that completion (set it well under
 *  the window, to leave room for the agent's turn before dispatch) lands on it.
 *  Off when the variable is unset. A render still running, or one that failed,
 *  never counts, since the next one may then land on a fresh container.
 */
import { env } from '$env/dynamic/private';
import { harnessPost } from '$lib/harness';

const lastByTier = new Map<number, string>();

export function rememberCustomNodeRender(gpuCount: number, workspaceId: string): void {
	lastByTier.set(gpuCount, workspaceId);
}

export async function containerStillWarm(gpuCount: number): Promise<boolean> {
	const windowSec = Number((env.AUTEUR_WARM_SKIP_PREFLIGHT_SEC ?? '').trim());
	if (!(windowSec > 0)) return false;
	const workspaceId = lastByTier.get(gpuCount);
	if (!workspaceId) return false;
	try {
		const res = await harnessPost(workspaceId, 'get-event-log', {}, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) return false;
		const raw: unknown = await res.json();
		const events = (typeof raw === 'string' ? raw : '')
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { t?: string; event?: string; status?: string });
		const done = events.filter((e) => e.event === 'complete' && e.status === 'success').pop();
		if (!done?.t) return false;
		return (Date.now() - Date.parse(done.t)) / 1000 < windowSec;
	} catch {
		return false;
	}
}
