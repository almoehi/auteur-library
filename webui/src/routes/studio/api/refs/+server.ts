/** Staging for reference files: attach, list, remove.
 *
 *  Upload lands here, on disk, not in the harness — see refs.server.ts for why.
 *  The trip to S3 happens at launch, when there is finally a workspace to
 *  import them into.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { MAX_REF_BYTES, addRef, describeRef, listRefs, removeRef } from '../../refs.server';

function view() {
	const rows = listRefs();
	return {
		files: rows.map((r) => ({
			id: r.stored,
			name: r.name,
			description: r.description,
			size: r.size
		})),
		totalBytes: rows.reduce((n, r) => n + r.size, 0)
	};
}

export const GET: RequestHandler = async () => json(view());

export const POST: RequestHandler = async ({ request }) => {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		throw error(400, 'expected multipart/form-data');
	}

	const files = form.getAll('file').filter((f): f is File => f instanceof File);
	if (!files.length) return json({ ok: false, error: 'no file in the request' });

	// Descriptions arrive positionally alongside the files; a missing one is not
	// fatal, but it is worth saying out loud, because the description is the
	// only thing the agents can read about a file they cannot see.
	const descriptions = form.getAll('description').map((d) => String(d));

	const added: string[] = [];
	for (const [i, f] of files.entries()) {
		if (f.size > MAX_REF_BYTES) {
			return json({
				ok: false,
				error: `${f.name} is ${(f.size / 1024 / 1024).toFixed(0)} MB — the limit is ${MAX_REF_BYTES / 1024 / 1024} MB`
			});
		}
		const bytes = new Uint8Array(await f.arrayBuffer());
		added.push(addRef(f.name, descriptions[i] ?? '', bytes).stored);
	}

	return json({ ok: true, added, ...view() });
};

/** The description is the whole value of a reference file to an agent, and it
 *  is the one field somebody will want to fix after dropping five files in a
 *  hurry. Editing it must not mean re-uploading the file. */
export const PATCH: RequestHandler = async ({ request }) => {
	let body: { id?: string; description?: string };
	try {
		body = (await request.json()) as { id?: string; description?: string };
	} catch {
		throw error(400, 'Body must be JSON');
	}
	if (!body.id) throw error(400, 'id is required');
	const ok = describeRef(body.id, body.description ?? '');
	return json({ ok, ...view() });
};

export const DELETE: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id') ?? '';
	if (!id) throw error(400, 'id is required');
	const gone = removeRef(id);
	return json({ ok: gone, ...view() });
};
