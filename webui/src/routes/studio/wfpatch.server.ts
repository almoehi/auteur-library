/** An experiment patch over the generated render bundle, for trying a graph
 *  change without editing the base export.
 *
 *  Off unless AUTEUR_WF_PATCH names a JSON file. The file is read on every
 *  request rather than once, so a run of A/B renders can change it between
 *  launches without restarting the server. Shape:
 *
 *    {
 *      "label": "rife-fast",                    // shown in logs only
 *      "graph": {
 *        "147": { "inputs": { "ensemble": false } },   // merge into a node's inputs
 *        "636": null,                                  // delete a node
 *        "900": { "class_type": "X", "inputs": {} }    // add or replace a node
 *      },
 *      "modelsYaml": "  - name: …\n    type: lora\n    files: …\n",  // extra models: rows
 *      "yamlTop": "customNodes:\n  - name: …\n",                  // extra top-level keys
 *      "gpuCount": 2,                                               // overrides AUTEUR_GPU_COUNT
 *      "preflight": true                                            // overrides AUTEUR_PREFLIGHT
 *    }
 *
 *  Rewiring is an inputs merge whose value is a [nodeId, slot] pair. */
import { env } from '$env/dynamic/private';
import { existsSync, readFileSync } from 'node:fs';

type Graph = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

export interface WfPatch {
	label?: string;
	graph?: Record<string, { class_type?: string; inputs?: Record<string, unknown> } | null>;
	modelsYaml?: string;
	yamlTop?: string;
	gpuCount?: number;
	/** true forces the pre-render checks on, which a render with customNodes
	 *  needs: the worker only clones and installs them when preflight is on. */
	preflight?: boolean;
	/** Rebuild the clip's adapter stack as a RayLoraLoader chain: every active
	 *  lora_N on node `from` (the Power Lora Loader the studio writes) becomes
	 *  one loader, and the chain feeds `into` (the RayUNETLoader). Without it a
	 *  Raylight graph renders with whatever adapters were hardcoded in the patch
	 *  rather than the ones this clip picked. */
	rayLoras?: { from: string; into: string };
}

export function readWfPatch(): WfPatch | null {
	const path = env.AUTEUR_WF_PATCH?.trim();
	if (!path || !existsSync(path)) return null;
	return JSON.parse(readFileSync(path, 'utf8')) as WfPatch;
}

export function applyGraphPatch(graph: Graph, patch: WfPatch | null): void {
	for (const [id, change] of Object.entries(patch?.graph ?? {})) {
		if (change === null) {
			delete graph[id];
		} else if (change.class_type) {
			graph[id] = { class_type: change.class_type, inputs: { ...(change.inputs ?? {}) } };
		} else {
			if (!graph[id]) throw new Error(`wf patch: node ${id} is not in the graph`);
			graph[id].inputs = { ...(graph[id].inputs ?? {}), ...(change.inputs ?? {}) };
		}
	}
	applyRayLoras(graph, patch?.rayLoras);
}

const RAY_LORA_BASE = 950;

function applyRayLoras(graph: Graph, spec: WfPatch['rayLoras']): void {
	if (!spec) return;
	const into = graph[spec.into];
	if (!into?.inputs) throw new Error(`wf patch: rayLoras target ${spec.into} is not in the graph`);
	const stack = Object.entries(graph[spec.from]?.inputs ?? {})
		.filter(([k, v]) => /^lora_\d+$/.test(k) && typeof v === 'object' && v !== null)
		.map(([k, v]) => ({ n: Number(k.slice(5)), ...(v as { on?: boolean; lora?: string; strength?: number }) }))
		.filter((e) => e.on && e.lora)
		.sort((a, b) => a.n - b.n);
	let prev: [string, number] | undefined;
	stack.forEach((e, i) => {
		const id = String(RAY_LORA_BASE + i);
		graph[id] = {
			class_type: 'RayLoraLoader',
			inputs: { lora_name: e.lora, strength_model: e.strength ?? 1.0, ...(prev ? { prev_ray_lora: prev } : {}) }
		};
		prev = [id, 0];
	});
	if (prev) into.inputs.lora = prev;
	else delete into.inputs.lora;
}
