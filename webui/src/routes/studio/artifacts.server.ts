/** Which artifact a run was launched to produce.
 *
 *  Three server-side pollers used to ask the same question the same way — "the
 *  first approved artifact that has any files" — and that answer was correct
 *  right up until a run also carried reference images. `importStagedRefs`
 *  creates `user_reference_material` and the harness approves it the moment it
 *  lands, so a workspace that is still rendering already holds one finished
 *  artifact full of PNGs. It sorts ahead of the clip.
 *
 *  Measured, not theorised: batch `b-mted861w-2ed9g`, take 1, 2026-08-29. Six
 *  seconds after launch the batch declared the take ready and filed
 *  `mtbw453v838bhj.png` — the character sheet — as the clip, cached it into the
 *  clip library as a take, and stopped watching. The GPU was still working; the
 *  render it produced four minutes later had nobody left to collect it.
 *
 *  The browser's own poller never had this bug, because it has always asked for
 *  an artifact holding a *video* file. This is that rule, plus the one the
 *  browser does not need: a sheet is an image and so are the references, so
 *  the reference artifact is excluded by name as well as by kind.
 */
export const REF_ARTIFACT_KEY = 'user_reference_material';

const KIND_RE = {
	video: /\.(mp4|webm|mov|m4v)$/i,
	image: /\.(png|jpe?g|webp|gif)$/i
} as const;

export interface PolledArtifact {
	id: string;
	key?: string;
	status?: string;
	files?: unknown[];
}

/** The finished artifact of the given kind, or null while there is not one yet.
 *
 *  `kind` is required rather than optional on purpose: every caller knows what
 *  it launched the workspace to make, and the one time a caller did not say,
 *  it accepted a reference image as a clip. */
export function pickOutput(
	artifacts: PolledArtifact[] | undefined,
	kind: 'video' | 'image'
): { artifact: string; file: string } | null {
	const re = KIND_RE[kind];
	for (const a of artifacts ?? []) {
		if (a.status !== 'approved') continue;
		if (a.key === REF_ARTIFACT_KEY) continue;
		const file = (a.files ?? []).map(String).find((f) => re.test(f));
		if (file) return { artifact: a.id, file };
	}
	return null;
}
