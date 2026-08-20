/** Move the staged reference files into a live workspace.
 *
 *  Three steps, in this order, because each one needs the last: the harness
 *  mints a pre-signed slot per file, the bytes go to that slot, and only then
 *  can the files be declared as an artifact — the import call describes files
 *  by URL, so nothing may be declared before it exists.
 *
 *  The upload runs from this server rather than from the browser. Hannes's own
 *  flow hands the pre-signed URL to the page and lets it PUT directly, which is
 *  the right shape for a hosted product; here it would put a cross-origin PUT
 *  from localhost against a bucket whose CORS rules we do not control, and a
 *  reference file that silently fails to upload is the kind of bug that costs a
 *  whole render to notice. Going through this process is one extra hop on a
 *  machine where both ends are local.
 */
import { clearRefs, listRefs, readRef } from './refs.server';
import { importUserArtifact, mintUploadUrls, type ImportFile } from './harness.server';

/** The key the artifact is registered under. It appears in the workspace's
 *  artifact index, so it has to read as what it is to an agent scanning that
 *  list for something to work with. */
export const REF_ARTIFACT_KEY = 'user_reference_material';

export interface RefImportResult {
	/** Absent when nothing was staged — not a failure, just an empty desk. */
	artifactId?: string;
	/** Names that made it in, for the launch report. */
	imported: string[];
	error?: string;
}

export async function importStagedRefs(workspaceId: string): Promise<RefImportResult> {
	const rows = listRefs();
	if (!rows.length) return { imported: [] };

	const minted = await mintUploadUrls(
		workspaceId,
		rows.map((r) => r.name)
	);
	if (minted.error) return { imported: [], error: minted.error };
	if (minted.slots.length !== rows.length) {
		return {
			imported: [],
			error: `the harness minted ${minted.slots.length} upload slots for ${rows.length} files`
		};
	}

	const files: ImportFile[] = [];
	for (const [i, row] of rows.entries()) {
		// Slots come back in request order, but match on the name where possible
		// so a reordering upstream cannot pair a file with someone else's URL.
		const slot = minted.slots.find((s) => s.fileName === row.name) ?? minted.slots[i];
		const bytes = readRef(row.stored);
		if (!bytes) return { imported: [], error: `${row.name} disappeared from the staging area` };

		let put: Response;
		try {
			put = await fetch(slot.uploadUrl, {
				method: 'PUT',
				// No content-type: the URL is signed for a specific set of headers
				// and adding one that was not signed for is a 403 from S3.
				body: new Uint8Array(bytes)
			});
		} catch (e) {
			return { imported: [], error: `uploading ${row.name} failed: ${String(e).slice(0, 200)}` };
		}
		if (!put.ok) {
			const detail = (await put.text()).slice(0, 200);
			return { imported: [], error: `uploading ${row.name} failed (${put.status}): ${detail}` };
		}

		files.push({
			name: row.name,
			// The agents cannot open the file. This sentence is the file, as far
			// as they are concerned — so an empty one is worth flagging in place
			// rather than sending an artifact nobody can reason about.
			description: row.description || `${row.name} — no description was given`,
			getUrl: slot.getUrl,
			size: row.size
		});
	}

	const imported = await importUserArtifact(workspaceId, {
		key: REF_ARTIFACT_KEY,
		title: 'Reference material',
		description:
			'Images and clips supplied by the user for this production. Hand them to a render workflow that accepts reference input; the per-file descriptions say what each one is for.',
		files
	});

	if (imported.error) return { imported: [], error: imported.error };

	// Staged files belong to the production that just consumed them. Leaving
	// them would quietly attach last week's face to the next film.
	clearRefs();
	return { artifactId: imported.artifactId, imported: files.map((f) => f.name) };
}
