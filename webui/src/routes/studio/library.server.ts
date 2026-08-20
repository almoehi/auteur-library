/** The local library of user workflows and skills.
 *
 *  The harness can now take a ComfyUI workflow or a skill straight from this
 *  machine — no GitHub round-trip. But its endpoints are workspace-scoped:
 *  they load into a workspace that is already open, and a workspace here lives
 *  for one production and is then spent. So "my workflows" cannot live in the
 *  harness; it lives here, and every render workspace we open gets the enabled
 *  ones pushed into it right after it opens.
 *
 *  Files on disk rather than a database, for the same reason the tuning
 *  overrides are: this is a single-user local tool, and being able to drop a
 *  workflow.json into a folder — or delete one that broke a render — is worth
 *  more than any query the store would gain.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), 'auteur', 'studio-library');
const WF_DIR = join(ROOT, 'workflows');
const SK_DIR = join(ROOT, 'skills');

/** The harness names workflows into LLM tool names (`wf_<name>`), so the name
 *  has to survive that without quoting. Hannes's own guidance is camel_case,
 *  alphanumeric — this is that rule, enforced where it can still be explained
 *  to whoever typed it. */
export const NAME_RE = /^[a-z][a-z0-9_]{2,48}$/;

/** Which compute backend runs the workflow. Absent means the harness picks. */
export type Provider = 'modal' | 'beam' | 'runpod';

export interface StoredWorkflow {
	name: string;
	/** The ComfyUI graph, verbatim. Required by the harness. */
	jsonContent: string;
	/** The converted bundle, when the conversion skill produced one. It carries
	 *  the ports, the gpu_types and the per-workflow agent instructions, so a
	 *  workflow with a bundle behaves far better than one without. */
	yamlContent?: string;
	description?: string;
	/** Defer provisioning until first use rather than at load time. */
	lazy?: boolean;
	provider?: Provider;
	/** Ours, not the harness's: whether new productions get this one. */
	enabled: boolean;
	updatedAt: string;
}

export interface StoredSkill {
	name: string;
	markdownContent: string;
	enabled: boolean;
	updatedAt: string;
}

function ensure(): void {
	for (const d of [WF_DIR, SK_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function readJson<T>(path: string): T | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
		return parsed && typeof parsed === 'object' ? (parsed as T) : null;
	} catch {
		// A hand-edited file that no longer parses should cost you that one
		// entry, not the whole library page.
		return null;
	}
}

function listDir<T extends { name: string }>(dir: string): T[] {
	ensure();
	const out: T[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith('.json')) continue;
		const item = readJson<T>(join(dir, f));
		if (item?.name) out.push(item);
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function listWorkflows(): StoredWorkflow[] {
	return listDir<StoredWorkflow>(WF_DIR);
}

export function listSkills(): StoredSkill[] {
	return listDir<StoredSkill>(SK_DIR);
}

export function saveWorkflow(w: Omit<StoredWorkflow, 'updatedAt'>): StoredWorkflow {
	ensure();
	const stored: StoredWorkflow = { ...w, updatedAt: new Date().toISOString() };
	writeFileSync(join(WF_DIR, `${w.name}.json`), JSON.stringify(stored, null, 2), 'utf8');
	return stored;
}

export function saveSkill(s: Omit<StoredSkill, 'updatedAt'>): StoredSkill {
	ensure();
	const stored: StoredSkill = { ...s, updatedAt: new Date().toISOString() };
	writeFileSync(join(SK_DIR, `${s.name}.json`), JSON.stringify(stored, null, 2), 'utf8');
	return stored;
}

export function deleteWorkflow(name: string): boolean {
	const p = join(WF_DIR, `${name}.json`);
	if (!existsSync(p)) return false;
	rmSync(p);
	return true;
}

export function deleteSkill(name: string): boolean {
	const p = join(SK_DIR, `${name}.json`);
	if (!existsSync(p)) return false;
	rmSync(p);
	return true;
}

/** Size of a stored workflow's graph, for the list — a 2 MB ComfyUI export and
 *  a 20 KB one behave very differently and the number is the only warning. */
export function workflowSize(name: string): number {
	try {
		return statSync(join(WF_DIR, `${name}.json`)).size;
	} catch {
		return 0;
	}
}

export const LIBRARY_PATH = ROOT;
