/** Turns the documents the crew writes into blocks the page can lay out.
 *
 *  These files arrive as markdown (screenplay, scene list, art direction) or as
 *  JSON (visual bible), and until now the page printed them verbatim — which
 *  meant a scene list showed up as a wall of `| Scene | Setting | ... |`, the
 *  one document a reader most wants to scan.
 *
 *  This returns DATA, not HTML: the component renders each block with ordinary
 *  Svelte markup, so nothing model-written is ever injected as markup and there
 *  is no escaping to get wrong. The parser handles only what these documents
 *  actually contain — it is not a markdown implementation and should not grow
 *  into one.
 */

export type Span = { text: string; bold?: boolean; italic?: boolean };

export type Block =
	| { kind: 'heading'; level: 1 | 2 | 3; text: string }
	| { kind: 'para'; spans: Span[] }
	| { kind: 'list'; items: Span[][] }
	| { kind: 'table'; head: string[]; rows: string[][] }
	| { kind: 'rule' }
	/** Screenplay: a scene heading (INT./EXT. …) */
	| { kind: 'slug'; text: string }
	/** Screenplay: a character cue and the lines under it */
	| { kind: 'cue'; who: string; parenthetical?: string; lines: string[] }
	/** Screenplay: FADE TO BLACK. and friends */
	| { kind: 'transition'; text: string }
	/** Visual bible: one anchor — the thing every render prompt inherits */
	| { kind: 'anchor'; label: string; text: string };

/** `**bold**` and `*italic*`. Deliberately no links, images or code: none of
 *  these documents contain them, and every construct supported is a construct
 *  that has to be rendered safely. */
function spans(text: string): Span[] {
	const out: Span[] = [];
	// Split on the emphasis markers, keeping them, then walk the pieces.
	const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
	for (const p of parts) {
		if (!p) continue;
		if (p.startsWith('**') && p.endsWith('**') && p.length > 4) {
			out.push({ text: p.slice(2, -2), bold: true });
		} else if (p.startsWith('*') && p.endsWith('*') && p.length > 2) {
			out.push({ text: p.slice(1, -1), italic: true });
		} else {
			out.push({ text: p });
		}
	}
	return out.length ? out : [{ text }];
}

/** A markdown table row: leading and trailing pipes are optional in the wild,
 *  so strip them before splitting rather than trusting either. */
function cells(line: string): string[] {
	return line
		.replace(/^\s*\|/, '')
		.replace(/\|\s*$/, '')
		.split('|')
		.map((c) => c.trim());
}

const IS_TABLE_ROW = /\|/;
/** The `| :--- | ---: |` separator under a table's header. */
const IS_TABLE_RULE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;
const IS_SLUG = /^\s*(INT\.|EXT\.|INT\/EXT\.|I\/E\.)/i;
const IS_TRANSITION = /^\s*(>\s*.+|[A-Z][A-Z\s]+TO:)\s*$/;
/** A Fountain character cue: a short all-caps line with no sentence
 *  punctuation, optionally with an extension like (V.O.). */
const IS_CUE = /^[A-Z][A-Z0-9 .'’-]{0,30}(\s*\([^)]+\))?$/;

function parseMarkdown(src: string): Block[] {
	const lines = src.replace(/\r\n/g, '\n').split('\n');
	const out: Block[] = [];
	let para: string[] = [];

	const flushPara = () => {
		if (!para.length) return;
		const text = para.join(' ').trim();
		if (text) out.push({ kind: 'para', spans: spans(text) });
		para = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const line = raw.trimEnd();
		const t = line.trim();

		if (!t) {
			flushPara();
			continue;
		}

		// ── table: a header row followed by the dashed separator ──
		if (IS_TABLE_ROW.test(t) && i + 1 < lines.length && IS_TABLE_RULE.test(lines[i + 1])) {
			flushPara();
			const head = cells(t);
			const rows: string[][] = [];
			i += 2;
			while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
				rows.push(cells(lines[i]));
				i++;
			}
			i--; // the outer loop will advance past the line that ended the table
			out.push({ kind: 'table', head, rows });
			continue;
		}

		// ── headings ──
		const h = /^(#{1,3})\s+(.*)$/.exec(t);
		if (h) {
			flushPara();
			out.push({ kind: 'heading', level: h[1].length as 1 | 2 | 3, text: h[2].trim() });
			continue;
		}

		if (/^(-{3,}|_{3,}|\*{3,})$/.test(t)) {
			flushPara();
			out.push({ kind: 'rule' });
			continue;
		}

		// ── bullets: gather the whole run ──
		if (/^[-*•]\s+/.test(t)) {
			flushPara();
			const items: Span[][] = [];
			while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
				items.push(spans(lines[i].replace(/^\s*[-*•]\s+/, '').trim()));
				i++;
			}
			i--;
			out.push({ kind: 'list', items });
			continue;
		}

		// ── screenplay shapes ──
		if (IS_SLUG.test(t) || (t.startsWith('.') && t.length > 1 && t === t.toUpperCase())) {
			flushPara();
			out.push({ kind: 'slug', text: t.replace(/^\./, '') });
			continue;
		}
		if (IS_TRANSITION.test(t)) {
			flushPara();
			out.push({ kind: 'transition', text: t.replace(/^>\s*/, '') });
			continue;
		}
		// A cue only counts when a line actually follows it — otherwise an
		// all-caps sentence in an action block would swallow the paragraph after it.
		if (IS_CUE.test(t) && t === t.toUpperCase() && lines[i + 1]?.trim()) {
			const m = /^([^(]+?)\s*(\(([^)]+)\))?$/.exec(t);
			const who = (m?.[1] ?? t).trim();
			const parenthetical = m?.[3]?.trim();
			const spoken: string[] = [];
			i++;
			while (i < lines.length && lines[i].trim()) {
				spoken.push(lines[i].trim());
				i++;
			}
			i--;
			flushPara();
			// Fountain puts a delivery cue on its own line under the character, so
			// the first spoken line is often "(quietly)" — an instruction, not a
			// line. Lift it out so the dialogue reads as dialogue.
			let par = parenthetical;
			if (!par && spoken.length > 1 && /^\(.+\)$/.test(spoken[0])) {
				par = spoken[0].slice(1, -1);
				spoken.shift();
			}
			out.push({ kind: 'cue', who, parenthetical: par, lines: spoken });
			continue;
		}

		para.push(t);
	}
	flushPara();
	return out;
}

/** The visual bible is the one document whose shape we know exactly, because a
 *  skill in the workflow library writes it: a style block, then one anchor per
 *  character and per location. Those anchor phrases are pasted verbatim into
 *  every render prompt, so they are what a reader needs to check — showing them
 *  as raw JSON hides the only thing worth looking at. */
function parseVisualBible(src: string): Block[] | null {
	let data: unknown;
	try {
		data = JSON.parse(src);
	} catch {
		return null;
	}
	if (!data || typeof data !== 'object') return null;

	const d = data as Record<string, unknown>;
	const out: Block[] = [];

	const anchorOf = (v: unknown): string => {
		if (typeof v === 'string') return v;
		if (v && typeof v === 'object') {
			const o = v as Record<string, unknown>;
			for (const k of ['t2i_anchor', 'anchor', 'anchor_phrase', 'description', 'prompt']) {
				if (typeof o[k] === 'string') return o[k] as string;
			}
		}
		return '';
	};

	const style = d.style as Record<string, unknown> | string | undefined;
	if (style) {
		out.push({ kind: 'heading', level: 2, text: 'Style' });
		if (typeof style === 'string') {
			out.push({ kind: 'anchor', label: 'style', text: style });
		} else {
			for (const [k, v] of Object.entries(style)) {
				if (typeof v === 'string' && v.trim()) {
					out.push({ kind: 'anchor', label: k.replace(/_/g, ' '), text: v });
				}
			}
		}
	}

	for (const [section, title] of [
		['characters', 'Characters'],
		['locations', 'Locations']
	] as const) {
		const block = d[section];
		if (!block || typeof block !== 'object') continue;
		const entries = Object.entries(block as Record<string, unknown>);
		if (!entries.length) continue;
		out.push({ kind: 'heading', level: 2, text: title });
		for (const [name, v] of entries) {
			const text = anchorOf(v);
			if (text) out.push({ kind: 'anchor', label: name.replace(/_/g, ' '), text });
		}
	}

	return out.length ? out : null;
}

/** Parse a document for display. `name` picks the strategy: only the visual
 *  bible gets the JSON treatment, everything else is markdown-ish. Falls back
 *  to plain paragraphs whenever a parse would otherwise lose content. */
export function renderDocument(name: string, body: string): Block[] {
	const text = (body ?? '').trim();
	if (!text) return [];

	if (name.toLowerCase().endsWith('.json')) {
		const bible = parseVisualBible(text);
		if (bible) return bible;
		// Unknown JSON: show it as-is rather than guessing at its shape.
		return [{ kind: 'para', spans: [{ text }] }];
	}

	return parseMarkdown(text);
}
