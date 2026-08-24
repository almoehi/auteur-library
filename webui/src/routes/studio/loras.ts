/** The adapters a clip can be rendered with, and what each one is for.
 *
 *  The workflow bundle in git carries one fixed pair — the turbo adapter and
 *  the realism detailer — because a bundle is a file and a file cannot decide
 *  anything. Everything past that pair is chosen per clip, which is the whole
 *  point: a blowjob wants the blowjob adapter and the penis detailer, a
 *  missionary shot wants neither and wants two others, and a bundle committed
 *  ahead of time can only ever be right about one of them.
 *
 *  So the bundle is generated at render time from this list. `key` is what the
 *  prompt writer returns and what travels in the URL, so it stays short and
 *  free of dashes — the URL splits pairs on the last dash.
 *
 *  `strength` is the author's own recommendation, read off each model's page
 *  rather than guessed. Where an author gave a range the midpoint is used,
 *  except where they named a figure they run themselves.
 */

export interface Lora {
	/** URL-safe, dash-free. What the writer names and what the path carries. */
	key: string;
	/** For the card, so you can see what was chosen without decoding a key. */
	label: string;
	/** Filename on the Modal volume. The graph refers to it as MINIMAX\<file>. */
	file: string;
	url: string;
	sha256: string;
	/** The author's recommendation. Overridable per clip. */
	strength: number;
	/** The range the author themselves gave, where they gave one. The writer may
	 *  place the strength anywhere inside it and nowhere outside it.
	 *
	 *  Absent on most of these, and left absent on purpose. Inventing a band for
	 *  an adapter whose author never published one just moves the guess up a
	 *  level and dresses it as provenance — those keep the fixed number. */
	band?: [number, number];
	/** Words that aim the adapter. They do not switch it on — a loaded adapter
	 *  is always acting — but the prompt lands closer with them present. */
	trigger?: string;
	/** Shown to the writer so it can choose. One line, plain, no adjectives:
	 *  the writer is picking equipment, not being sold it. */
	use: string;
	/** Acts are mutually exclusive — a clip is one thing happening. Everything
	 *  else stacks. The writer is told this rather than left to infer it. */
	kind: 'base' | 'act' | 'detail';
}

/** Always loaded, both of them, in every clip. The turbo adapter is what makes
 *  four steps possible and the detailer is what keeps skin from reading as
 *  plastic; neither has anything to do with what is happening in the shot. */
export const BASE: Lora[] = [
	{
		key: 'turbo',
		label: 'LightX2V turbo 4-step',
		file: 'minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors',
		url: 'https://huggingface.co/Kijai/MiniMax-H3_comfy/resolve/main/loras/minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors',
		sha256: 'fc9b6500f0331fe925b004738baaa31bd34104741c8bf9334816f9ac3005c8c1',
		strength: 0.7,
		use: 'the speed distillation the step count is built around',
		kind: 'base'
	},
	{
		key: 'realism',
		label: 'PlagueKind realism slider',
		file: 'PlagueKind-tiddies-realismslider.safetensors',
		url: 'https://civitai.com/api/download/models/3229050?fileId=3111384',
		sha256: 'e5c8c275af58663a664ad2922cc10a248bff70b941043375d2c82d9cc55b7030',
		strength: 1.6,
		/** author: realistic band 1.0-2.0, breaks past 2.0 */
		band: [1.0, 2.0],
		use: 'skin texture — pores, freckles, uneven tone',
		kind: 'base'
	}
];

/** Chosen per clip. Exactly one `act`, any number of `detail`. */
export const CATALOGUE: Lora[] = [
	{
		key: 'bj',
		label: 'Blowjob v2.1',
		file: 'MM-H3 - Blowjob v2.1.safetensors',
		url: 'https://civitai.com/api/download/models/3235946?fileId=3118341',
		sha256: 'aef6d0c6b758352fd4cfe302d3b9121fb0c18e470bde4bdb2025229e1febee6d',
		strength: 1.2,
		/** author: 'Strength: 1.0 - 1.5' */
		band: [1.0, 1.5],
		trigger: 'bl0w_j0b',
		use: 'oral sex, mouth on cock',
		kind: 'act'
	},
	{
		key: 'deep',
		label: "Daring's Deepthroat",
		file: 'deepthroat_v02.safetensors',
		url: 'https://civitai.com/api/download/models/3226989?fileId=3109184',
		sha256: '1fd239662f6290255b0bb3a220764fb53aab2859378f7fd3024030c1e1991cb2',
		strength: 0.8,
		use: 'oral sex taken deep into the throat',
		kind: 'act'
	},
	{
		key: 'miss',
		label: 'POV Missionary Insertion',
		file: 'H3_Mis_Insrt_v07.safetensors',
		url: 'https://civitai.com/api/download/models/3210503?fileId=3092209',
		sha256: '8d1ed16cdae02e25308063053f7f459b88fb4c50d7e6ea4d05ebc4950a992584',
		strength: 0.8,
		use: 'vaginal penetration seen from above, missionary',
		kind: 'act'
	},
	{
		key: 'aio',
		label: 'HMNSFW AIO V2',
		file: 'HMNSFW_AIO_V2.safetensors',
		url: 'https://civitai.com/api/download/models/3206518?fileId=3088013',
		sha256: '608e4212f2788b6063330ff1196fc1f4b4228cfd9a413a63c198a09d7e4a61cb',
		strength: 0.5,
		/** author: 'use it at strength 0.5 or below' */
		band: [0.3, 0.5],
		trigger: 'hmmotion',
		use: 'sex in general — the fallback when no other act fits',
		kind: 'act'
	},

	{
		key: 'penis',
		label: 'HMPenis v2.0',
		file: 'PenisV2_minimax-h3_epoch60.safetensors',
		url: 'https://civitai.com/api/download/models/3247473?fileId=3130327',
		sha256: '017dd1adddc1be3ec0605dd2e7de97138eb2c6c6ba24be402cf47f103ac1f1b3',
		strength: 0.8,
		trigger: 'penis',
		use: 'the cock itself is the subject — the frame is on it, not merely containing it',
		kind: 'detail'
	},
	{
		key: 'pussy',
		label: 'HMPussy v0.5',
		file: 'hmpussy_v6_epoch30.safetensors',
		url: 'https://civitai.com/api/download/models/3215304?fileId=3097100',
		sha256: '3080f4fbcbba4fc06bd09240c7eedb6a5128eb0e19feb001cdf97a7a0941a6ee',
		strength: 0.8,
		trigger: 'hmpussy',
		use: 'her pussy is the subject — the frame is on it, not merely containing it',
		kind: 'detail'
	},
	{
		key: 'breast',
		label: 'Breast Play & Jiggle',
		file: 'breastplayjiggle_h3_v1.safetensors',
		url: 'https://civitai.com/api/download/models/3225638?fileId=3107724',
		sha256: 'f9cbcaa596b6b281f154388e407e7b4c4ee97ba9917614ab36bc5e86edf374f5',
		strength: 0.75,
		/** author: '0.7-0.8 seems to be the sweet spot', 1.0 gives finger artifacts */
		band: [0.7, 0.8],
		use: 'breasts move, or are touched',
		kind: 'detail'
	},
	{
		key: 'moan',
		label: 'moawxx moans + writhing',
		file: 'moawxx_000002500.safetensors',
		url: 'https://civitai.com/api/download/models/3228089?fileId=3110353',
		sha256: '7891ae89ca83c391277692aef5218d3228e22f5bad0d92f55ed1676f36813918',
		strength: 0.75,
		/** author: '0.6 - 0.85 (1.0 often degrades image quality)' */
		band: [0.6, 0.85],
		trigger: 'moawxx',
		use: 'she moans, and her body responds to it',
		kind: 'detail'
	},
	{
		key: 'cum',
		label: 'Cumshot (CoachBate)',
		file: 'MiniMax-H3_cum_coachbate_v1_07000.safetensors',
		url: 'https://civitai.com/api/download/models/3207014?fileId=3099046',
		sha256: '0d30b04818137f199085c82258ec200610002cfd9d1f1ce1d3375dee7cea6520',
		strength: 0.8,
		trigger: 'CBL0ADZ',
		use: 'the shot ends in ejaculation',
		kind: 'detail'
	},
	{
		key: 'mystic',
		label: 'Mystic XXX v3',
		file: 'MysticXXX_MMH3-V3.safetensors',
		url: 'https://civitai.com/api/download/models/3260276?fileId=3143593',
		sha256: '99307e313784cbea7d9ee2a56ecb8794272f1024737985b824eca8c5c619a0b6',
		strength: 0.9,
		/** author: '0.5 - 0.9', runs 0.9 themselves */
		band: [0.5, 0.9],
		use: 'general explicit-scene quality, no particular act',
		kind: 'detail'
	}
];

const BY_KEY = new Map([...BASE, ...CATALOGUE].map((l) => [l.key, l]));

export function loraFor(key: string): Lora | undefined {
	return BY_KEY.get(key);
}

/** One chosen adapter: which, and how hard. */
export interface Pick {
	key: string;
	strength: number;
}

/** How many can be stacked before the render turns to soup. Base pair excluded.
 *
 *  Four was the opening guess and it did not survive its first outing: a POV
 *  missionary clip rendered with miss + penis + pussy + breast came back with
 *  the anatomy at the point of penetration incoherent — everything else in the
 *  frame correct, that one region not. Two adapters were drawing the same few
 *  hundred pixels and disagreed.
 *
 *  Two is not a measured number either, and saying otherwise would be pretending
 *  we know something we do not. It is the smallest count that still does the job
 *  the feature exists for — the act, plus the one thing that most needs helping —
 *  and it is the safe end to start from when the only evidence in hand is a
 *  failure at four. If clips start looking underserved, raise it a notch and
 *  look; do not raise it on the argument that more adapters must be better,
 *  which is the argument that produced the broken one. */
export const MAX_PICKS = 2;

/** Parse the selection out of a URL path segment.
 *
 *  `bj-1.2,penis-0.8,moan-0.75` — pairs split on the last dash, so a key can
 *  never be mistaken for part of a number. Unknown keys are dropped rather
 *  than failing the request: a render that quietly loses one adapter is
 *  recoverable, and one that 404s at the harness is a dead workspace.
 */
export function parsePicks(seg: string): Pick[] {
	const out: Pick[] = [];
	for (const raw of decodeURIComponent(seg).split(',')) {
		const part = raw.trim();
		if (!part) continue;
		const cut = part.lastIndexOf('-');
		if (cut < 1) continue;
		const key = part.slice(0, cut);
		const n = Number(part.slice(cut + 1));
		if (!BY_KEY.has(key) || !Number.isFinite(n)) continue;
		// Base adapters are never picks. They load on every clip regardless, and
		// letting one through here would let it fill the cap below and push a real
		// choice off the end — which is exactly what happened once already, and
		// silently, because the url looked correct while the graph was not.
		if (BY_KEY.get(key)!.kind === 'base') continue;
		out.push({ key, strength: Math.min(3, Math.max(0, n)) });
	}
	return out.slice(0, MAX_PICKS);
}

export function formatPicks(picks: Pick[]): string {
	return picks.map((p) => `${p.key}-${p.strength}`).join(',');
}

/** The catalogue as the writer reads it.
 *
 *  Generated from the list above rather than written out again in the prompt,
 *  because the two would drift and the drift would be silent: the writer would
 *  keep naming an adapter that had been removed, the render would quietly lose
 *  it, and nothing anywhere would say so.
 */
export function catalogueForWriter(): string {
	const line = (l: Lora) => {
		const w = l.band ? `${l.strength} (${l.band[0]}-${l.band[1]})` : `${l.strength} fixed`;
		return `  ${l.key.padEnd(8)}${w.padEnd(16)}${l.use}` +
			(l.trigger ? `  [trigger: ${l.trigger}]` : '');
	};
	const acts = CATALOGUE.filter((l) => l.kind === 'act').map(line).join('\n');
	const details = CATALOGUE.filter((l) => l.kind === 'detail').map(line).join('\n');

	return `ADAPTERS

Along with the prompt, choose the adapters this clip is rendered with. Two are
loaded on every clip regardless — the speed distillation and the skin detailer —
and are not yours to pick. From the lists below choose:

  - exactly one ACT: the thing that is happening in this shot
  - at most one DETAIL, and only when it is central to the shot
  - ${MAX_PICKS} in total, never more

Prefer the act alone. A detail earns its place only when the request turns on
it — a shot that ends in a cumshot needs the cumshot adapter, a shot where the
moaning is the point needs the moaning one. A detail that is merely true of the
frame is not worth an adapter slot, and adding it costs something real.

The two anatomy detailers are the ones to be most careful with. They draw a
small region of the frame very hard, and every clip so far that carried one came
back with that region incoherent — a penetration rendered as one fused mass
rather than a shaft and an opening. Take one only when that anatomy is what the
frame is built around, and never both: they draw the same pixels and disagree.

Where a shot shows a join — penetration, a mouth on a cock — the act adapter
already knows how the parts meet. Adding a detailer on top of it is the case
that has failed, so prefer the act alone unless the request is specifically
about how one of the parts looks.

Return them in the "loras" field as [{"key":"bj","strength":1.2}, …].

The number beside each is the adapter author's own recommendation. Where a range
follows it in brackets, that is the range the author published, and you may
place the strength anywhere inside it: higher when the thing that adapter does is
what the request is really about, lower when it is present but not the point.
Never go outside the range. Where the number says "fixed" the author published no
range, so send that number unchanged — a range nobody measured is not yours to
invent either.

Choose on what the shot actually contains, not on what sounds related. An
adapter for something that is not in the frame does not sit idle — a loaded
adapter is always acting, and one trained on the wrong thing pulls the image
toward it. Where a trigger word is listed, the shot lands closer if that word
appears naturally somewhere in the prompt text; the word aims the adapter, it
does not switch it on.

ACTS — choose exactly one
${acts}

DETAILS — choose any that are true of this shot
${details}`;
}
