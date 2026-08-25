/** The one thing this pipeline must never render.
 *
 *  This exists because it failed. A character preview was asked for with no age
 *  in the request; the writer — correctly following its own rule of adding
 *  nothing the operator did not say — passed through
 *  `A photography of full body of a brown-haired girl with rather large breasts`,
 *  and the model rendered a child. Nothing in the chain objected, because
 *  nothing in the chain had been asked to.
 *
 *  Two lessons are baked in here. First, "add nothing" is the right instinct for
 *  wardrobe and hair and mood, and exactly the wrong one for age: an omitted age
 *  is not neutral, it is an unanchored subject, and an unanchored subject in a
 *  pipeline that also produces nudity is the failure above. So the writer is now
 *  required to state an adult age, and that is the single exception to its rule.
 *
 *  Second, a prompt is guidance and a guard has to be a guard. A model that
 *  usually complies is not a control. So this runs deterministically on both
 *  sides of the writer — what the operator typed and what the writer produced —
 *  and refuses rather than repairs. Repairing would mean guessing what someone
 *  meant, and the whole point is that this is the one case where guessing is not
 *  acceptable.
 *
 *  Deliberately not a general profanity filter. This studio produces explicit
 *  adult material on purpose and every other word is allowed through untouched.
 *  The list below is narrow and about one thing.
 */

/** Words that describe a child, in the two languages this app is operated in.
 *  Matched on word boundaries so `adult`, `matured` and similar survive. */
const UNDERAGE_WORDS = [
	// English
	'child',
	'children',
	'kid',
	'kids',
	'toddler',
	'infant',
	'baby',
	'preteen',
	'pre-teen',
	'teen',
	'teens',
	'teenage',
	'teenager',
	'adolescent',
	'minor',
	'underage',
	'under-age',
	'schoolgirl',
	'schoolboy',
	'school girl',
	'school boy',
	'pupil',
	'loli',
	'lolita',
	'shota',
	'jailbait',
	'juvenile',
	'youngster',
	// Hungarian
	'gyerek',
	'gyermek',
	'kiskorú',
	'kiskoru',
	'kislány',
	'kislany',
	'kisfiú',
	'kisfiu',
	'kamasz',
	'tini',
	'tinédzser',
	'tinedzser',
	'serdülő',
	'serdulo',
	'óvodás',
	'ovodas',
	'iskolás',
	'iskolas',
	'kiskamasz',
	'csecsemő',
	'csecsemo'
];

/** `girl` and `boy` are not on the list above, because in adult material they
 *  are ordinary words for adults and refusing them would be wrong. They are
 *  still not safe to send to an image model *unanchored* — the failure that
 *  produced this file was exactly `girl` with no age beside it — so they are
 *  handled separately: allowed in what you type, never allowed in what the
 *  writer sends onward. */
const AMBIGUOUS_WORDS = ['girl', 'girls', 'boy', 'boys', 'lány', 'lany', 'fiú', 'fiu'];

const ADULT_MIN = 18;

function wordRe(words: string[]): RegExp {
	// Unicode-aware boundaries: \b does not do the right thing next to á, ő, ú.
	const alts = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	return new RegExp(`(?<![\\p{L}\\p{N}])(${alts})(?![\\p{L}\\p{N}])`, 'iu');
}

const UNDERAGE_RE = wordRe(UNDERAGE_WORDS);
const AMBIGUOUS_RE = wordRe(AMBIGUOUS_WORDS);

/** Ages written as a number, in the forms either language produces:
 *  `17-year-old`, `17 years old`, `17 éves`, `age 17`, `aged 17`. */
const AGE_PATTERNS = [
	/(\d{1,3})\s*[-–]?\s*year[-\s]?old/giu,
	/(\d{1,3})\s*years?\s+old/giu,
	/(\d{1,3})\s*[-–]?\s*éves/giu,
	/\bage[d]?\s*[:=]?\s*(\d{1,3})/giu
];

/** Every age the text states, in years. */
export function statedAges(text: string): number[] {
	const out: number[] = [];
	for (const re of AGE_PATTERNS) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) {
			const n = Number(m[1]);
			if (Number.isFinite(n) && n > 0 && n < 130) out.push(n);
		}
	}
	return out;
}

export interface MinorCheck {
	/** Set when the text must not be rendered. */
	refuse?: string;
}

/** What the operator typed. Refuses only what is unambiguous — a stated age
 *  under eighteen, or a word that means a child. `girl` alone is fine here; it
 *  is the writer's job to turn it into an adult, and the output check below
 *  enforces that it did. */
export function checkRequest(text: string): MinorCheck {
	const young = statedAges(text).filter((n) => n < ADULT_MIN);
	if (young.length) {
		return {
			refuse: `That describes someone aged ${young[0]}. Everyone this tool renders has to be an adult — put an age of 18 or over in the description.`
		};
	}
	const m = UNDERAGE_RE.exec(text);
	if (m) {
		return {
			refuse: `That describes a minor ("${m[1]}"). This tool only renders adults, and that is not something I can work around — describe an adult instead.`
		};
	}
	return {};
}

/** What the writer produced, on its way to the image model. Stricter than the
 *  request check on purpose: this string is about to become a picture, so it has
 *  to carry an adult age explicitly and must not lean on a word that reads young
 *  without one. */
export function checkDescription(text: string): MinorCheck {
	const first = checkRequest(text);
	if (first.refuse) return first;

	const ages = statedAges(text);
	if (!ages.length) {
		return {
			refuse:
				'Say how old they are — an age of 18 or over, in words like "a 28-year-old woman". Without one the model has nothing anchoring the subject as an adult, and that is exactly how a render comes back looking like a child.'
		};
	}
	const a = AMBIGUOUS_RE.exec(text);
	if (a && !ages.some((n) => n >= ADULT_MIN)) {
		return {
			refuse: `"${a[1]}" needs an adult age beside it — write "a 24-year-old woman" rather than leaving it open.`
		};
	}
	return {};
}
