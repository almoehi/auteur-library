/** The workflow bundle for one clip, assembled when the harness asks for it.
 *
 *  A bundle in git is a file, and a file cannot know whether the shot it is
 *  about to render needs the blowjob adapter or the missionary one. The two
 *  ways around that both end badly: commit a copy per adapter and every future
 *  change has to be made ten times, or commit a copy per combination and there
 *  are a hundred and twenty of them.
 *
 *  So the bundle is built here instead. The guide allows a workflow `url` to be
 *  a plain link rather than a `name@branch` registry ref, the studio is already
 *  an HTTP server, and the harness can reach it — which makes the third option
 *  available: one base in git, and a bundle per clip generated from it.
 *
 *  Two files are served because a bundle is two files. The YAML carries the
 *  ports and the model list, and its own `url: workflow.json` is relative, so
 *  the harness comes back to this same directory for the graph.
 *
 *  Unauthenticated and local, like the rest of this app — but note that this
 *  one is reachable from the Docker host as well, which is why vite.config.ts
 *  now names that host explicitly.
 */
import { error, text } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, loraFor, parsePicks, type Lora, type Pick } from '../../../../loras';

const BUNDLE = 'minimaxh3_t2v_i2v_ref2v_advanced_film_making_foxydit';

/** Where the base bundle lives. The webui runs inside the checkout, so the
 *  workflows directory is one level up — the same reach the prompt writer uses
 *  to read the harness's own skill files. */
function basePath(name: string): string {
	for (const p of [
		join(process.cwd(), '..', 'workflows', BUNDLE, name),
		join(process.cwd(), 'workflows', BUNDLE, name)
	]) {
		if (existsSync(p)) return p;
	}
	throw error(500, `the base bundle is not where it should be — looked for ${name}`);
}

/** The node the adapters are loaded by: rgthree's Power Lora Loader, which
 *  holds each one as its own nested block. Nested is exactly why the adapters
 *  cannot be switched through a port and have to be written into the graph. */
const LOADER_NODE = '674';

/** The pair, then the picks. Order matters to the loader only in that later
 *  adapters are applied over earlier ones; the base pair goes first so a shot
 *  adapter is layered on top of the realism pass rather than under it. */
function stack(picks: Pick[]): { lora: Lora; strength: number }[] {
	const out = BASE.map((l) => ({ lora: l, strength: l.strength }));
	for (const p of picks) {
		const l = loraFor(p.key);
		if (l && !BASE.some((b) => b.key === l.key)) out.push({ lora: l, strength: p.strength });
	}
	return out;
}

function buildJson(entries: { lora: Lora; strength: number }[]): string {
	const graph = JSON.parse(readFileSync(basePath('workflow.json'), 'utf8')) as Record<
		string,
		{ class_type?: string; inputs?: Record<string, unknown> }
	>;
	const node = graph[LOADER_NODE];
	if (!node?.inputs) throw error(500, `node ${LOADER_NODE} is missing from the base graph`);

	// Drop whatever the base carries and write the stack fresh, so the served
	// graph never inherits an adapter nobody asked for.
	for (const k of Object.keys(node.inputs)) {
		if (/^lora_\d+$/.test(k)) delete node.inputs[k];
	}
	entries.forEach((e, i) => {
		node.inputs![`lora_${i + 1}`] = {
			on: true,
			// The graph addresses adapters by their folder on the volume, and the
			// separator is a backslash because that is what the loader wrote.
			lora: `MINIMAX\\${e.lora.file}`,
			strength: e.strength
		};
	});
	return JSON.stringify(graph, null, 2);
}

/** The model entries for the stack, in the base file's own layout. */
function modelBlock(entries: { lora: Lora; strength: number }[]): string {
	const rows: string[] = [];
	for (const { lora } of entries) {
		const civitai = lora.url.includes('civitai.com');
		rows.push(
			`  - name: ${lora.file.replace(/\.safetensors$/, '')}`,
			`    type: lora`,
			`    dest: loras/MINIMAX/`,
			`    files:`,
			`      - url: ${lora.url}`,
			// Civitai serves the file behind a redirect that does not carry the
			// name, so it has to be stated. Hugging Face URLs end in the filename
			// and need no help.
			...(civitai ? [`        filename: ${lora.file}`] : []),
			`        sha256: ${lora.sha256}`,
			``
		);
	}
	return rows.join('\n');
}

const OPEN = '  # <<LORAS>>';
const CLOSE = '  # <</LORAS>>';

/** The bundle's own `name` is left exactly as the base file has it.
 *
 *  An earlier version stamped a fingerprint of the adapter stack onto it, as
 *  insurance against the harness caching bundles by name. It does not cache by
 *  name — it checks it, and refuses a bundle whose name disagrees with the
 *  workspace entry that asked for it:
 *
 *    WorkflowDownloader: YAML name mismatch — expected "…foxydit", got "…foxydit_h6e2h0"
 *
 *  Which is a better guarantee than the one being bought, and the insurance was
 *  the only thing that failed. Two adapter stacks now differ by URL alone, and
 *  since every run opens a fresh workspace there is nothing for a stale bundle
 *  to persist into. */
function buildYaml(entries: { lora: Lora; strength: number }[]): string {
	const src = readFileSync(basePath('workflow.yaml'), 'utf8');
	const a = src.indexOf(OPEN);
	const b = src.indexOf(CLOSE);
	if (a < 0 || b < 0 || b < a) {
		throw error(500, 'the base bundle has lost its <<LORAS>> markers — nothing to replace');
	}
	const head = src.slice(0, a);
	const tail = src.slice(b + CLOSE.length);
	const body =
		`  # Generated for one clip. Edit webui/src/routes/studio/loras.ts, not this.\n` +
		modelBlock(entries);
	return head + body + tail;
}

export const GET: RequestHandler = async ({ params }) => {
	const entries = stack(parsePicks(params.sel ?? ''));

	if (params.file === 'workflow.json') {
		return text(buildJson(entries), { headers: { 'content-type': 'application/json' } });
	}
	if (params.file === 'workflow.yaml' || params.file === 'workflow.yml') {
		return text(buildYaml(entries), { headers: { 'content-type': 'text/yaml' } });
	}
	throw error(404, 'a bundle is workflow.yaml and workflow.json, nothing else');
};
