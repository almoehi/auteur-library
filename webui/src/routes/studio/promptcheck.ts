/** What has to be true of a finished brief before a GPU is asked to render it.
 *
 *  Every rule here is a fault that has actually shipped a wrong clip, and every
 *  one of them is visible in the text — no model is asked, nothing is inferred
 *  from the picture. That is the whole design: the check has to be free, or it
 *  cannot run on the path between the writer finishing and the card appearing.
 *
 *  One definition, two callers. This runs in `api/shotprompt` on every brief a
 *  person is about to spend money on, and it is the same list a regression pass
 *  over a fixed set of requests would use. Written apart from both so the test
 *  and the live check cannot drift into asking different questions, which is the
 *  usual way a pair like this rots.
 *
 *  What it does NOT do: judge whether the brief is any good. It cannot tell that
 *  an adapter is drawing the wrong body, that the camera is in a place the model
 *  renders badly, or that the beats are dull. Those need a render and a person.
 */

export interface PromptFault {
	/** For logs and tests. */
	code: string;
	/** Handed to the writer verbatim on the retry — so it reads as an instruction,
	 *  not as a complaint. */
	says: string;
	/** Shown on the card if the retry does not clear it. Plain, and about the
	 *  clip rather than about the machinery. */
	human: string;
}

export interface CheckOpts {
	/** A continuation carries a reference video and a seam, and two of the rules
	 *  only make sense there. */
	continuation: boolean;
	/** The seam is nailed to the prior clip's final frame. */
	pinned: boolean;
}

/** Over this and the model starts losing the end of the brief.
 *
 *  The writer is told 400-700 and lands at 618-700 when it is behaving, so the
 *  threshold sits well clear of that: this is for a brief that has run away, not
 *  for one that is nine words long. */
const WORD_CEILING = 760;

/** A subject definition: the number, and everything said about it on that line. */
function subjects(prompt: string): { n: string; said: string }[] {
	const out = new Map<string, string>();
	for (const m of prompt.matchAll(/<Subject (\d+)>\s+is\s+([^\n]*)/g)) {
		// First definition wins. The number is repeated later in the description,
		// and those mentions are prose rather than definitions.
		if (!out.has(m[1])) out.set(m[1], m[2]);
	}
	return [...out].map(([n, said]) => ({ n, said }));
}

const ROOM = /\b(interior|room|location|setting|backdrop|apartment|hallway|office)\b/i;
/** Words that describe a body rather than name one. A subject with none of these
 *  and no picture behind it is a name with nobody attached. */
const BODY =
	/\b(build|body|torso|skin|hair|breasts?|nude|naked|dressed|wearing|shoulders|hips|thighs|beard|stubble|years?[- ]old|thin|slim|skinny|muscular|fit|chubby|tall|short)\b/i;

export function checkPrompt(prompt: string, opts: CheckOpts): PromptFault[] {
	const faults: PromptFault[] = [];
	const subs = subjects(prompt);

	// 1. A room on a subject number.
	//
	// The continuation template hardcoded "<Subject 2> is the interior" for
	// months, which spent the second subject number on a place and left a second
	// PERSON nowhere to be defined. A brief then asked for her to be fucked from
	// behind while the man existed only as "a hard penis", and the clips came
	// back with the woman alone.
	const room = subs.find((s) => ROOM.test(s.said) && !BODY.test(s.said));
	if (room) {
		faults.push({
			code: 'room-as-subject',
			says:
				`<Subject ${room.n}> is a place, and subject numbers are for people only. ` +
				`Describe the location without giving it a subject number, and renumber the people.`,
			human: 'the location was written as if it were a person'
		});
	}

	// 2. A person with neither a picture nor a body.
	//
	// A reference carries the body of whoever it shows; a subject with no
	// reference has only the words, and "he" is not words. This is the fault that
	// produced the woman alone on the couch.
	for (const s of subs) {
		if (ROOM.test(s.said) && !BODY.test(s.said)) continue;
		const hasPicture = /<Picture \d+>/.test(s.said);
		if (!hasPicture && !BODY.test(s.said)) {
			faults.push({
				code: 'person-without-body',
				says:
					`<Subject ${s.n}> has no reference picture and no physical description. ` +
					`Nothing shows the model who they are, so describe them — build, age, hair, ` +
					`skin, and what they are wearing or not wearing.`,
				human: `one of the people in this shot is named but never described`
			});
			break;
		}
	}

	// 3. A second person in the action who was never defined at all.
	//
	// Rule 2 checks the people that ARE declared, and the fault it was written for
	// slipped past it: the man was never a <Subject> in the first place. He
	// existed as "he", "his hips" and "a hard penis" — a body part is not a
	// person, and the clips came back with the woman alone.
	//
	// Any brief that declares somebody, not just a continuation.
	//
	// A clip brief with NO subjects at all legitimately puts both people in the
	// description, which is how the two-person clips that worked were written —
	// `subs.length` below is what excludes those. What is never a style is
	// declaring one person and leaving the other in prose: the asymmetry is the
	// fault, and it does not become one only because the clip is a continuation.
	//
	// This was continuations-only for a while, and a direct clip walked straight
	// through it: the woman was <Subject 1>, the man was "a naked adult man" and
	// "his hips", and he came back facing the wrong way and barely moving.
	// Re-scanned over every brief written so far, the extension names 38 more
	// clips out of 106 — all of them the same shape, none of them a style.
	//
	// POV is exempt. There the second person's body is deliberately out of frame
	// and only their hands or cock are in it, which is the shot rather than a
	// mistake.
	if (subs.length) {
		const people = subs.filter((s) => !(ROOM.test(s.said) && !BODY.test(s.said)));
		const secondParty =
			/\b(the man|a man|another (man|woman|person)|his (hips|hands?|cock|penis|thighs|chest))\b/i.test(
				prompt
			) || /\b(a|the|his) (hard |erect |thick )?(cock|penis)\b/i.test(prompt);
		const pov = /\bPOV\b|point of view/i.test(prompt);
		if (people.length < 2 && secondParty && !pov) {
			faults.push({
				code: 'undeclared-person',
				says:
					`The action involves somebody besides <Subject 1>, and that person is never ` +
					`declared. Give them their own <Subject N> with build, age, hair, skin and ` +
					`what they are wearing. A body part on its own is not a person, and the model ` +
					`renders what is described.`,
				human: 'a second person takes part in this shot but is never described'
			});
		}
	}

	// 4. Somebody arriving at a pinned seam, with nothing said about it.
	//
	// The pinned frame holds whoever was in the prior clip and nobody else. A
	// brief that adds a person and still says the opening instant matches that
	// frame is telling the model two things, and the picture wins.
	if (opts.continuation && opts.pinned) {
		const people = subs.filter((s) => !(ROOM.test(s.said) && !BODY.test(s.said)));
		const arrival = people.some((s) => !/<Picture \d+>/.test(s.said));
		if (people.length > 1 && arrival && !/NOT in <Picture 3>/.test(prompt)) {
			faults.push({
				code: 'arrival-at-pinned-seam',
				says:
					`This brief adds somebody <Picture 3> does not contain, while still saying ` +
					`the opening instant matches <Picture 3>. Use the override: say <Subject 1> ` +
					`is as <Picture 3> shows her at 0.00, that the new person is NOT in ` +
					`<Picture 3>, and write them entering in a later beat.`,
				human: 'somebody arrives in this shot, and the join is pinned to a frame without them'
			});
		}
	}

	// 5. A brief that ran away.
	const words = (prompt.match(/\S+/g) ?? []).length;
	if (words > WORD_CEILING) {
		faults.push({
			code: 'too-long',
			says:
				`The brief is ${words} words. Past about 700 the model reads the front and ` +
				`loses the rest, so the end of this one will not be rendered. Cut it back.`,
			human: 'this brief is long enough that the model may not read the end of it'
		});
	}

	// 6. Nobody's voice named.
	//
	// Silent until two clips later, which is what makes it worth catching here:
	// each clip is an independent roll, so a brief that says nothing about the
	// voice does not produce a clip without one — it produces a clip whose voice
	// the model chose, and the next clip gets a different woman.
	const sound = /^(?:overall_)?soundscape\s*:(.*?)(?=^\w+\s*:|\Z)/ms.exec(prompt)?.[1] ?? '';
	if (subs.length && sound.trim() && !/\bvoices?\b/i.test(sound)) {
		faults.push({
			code: 'no-voice',
			says:
				`The soundscape names no voice. Give each audible person one short sentence — ` +
				`pitch, weight, accent, pace — because the next clip inherits that sentence and ` +
				`without it the same person comes back sounding like somebody else.`,
			human: 'nobody in this shot has a voice described, so the next clip may not match'
		});
	}

	return faults;
}
