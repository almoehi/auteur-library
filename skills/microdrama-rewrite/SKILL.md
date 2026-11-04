---
name: microdrama-rewrite
description: >
  Use when your task prompt says "Load and use skill: microdrama-rewrite" — rewrite a raw story
  into one or more vertical micro-dramas (9:16, short episodes, each opening on a hook and ending
  on a cliffhanger) as `series.md` + one `drama_<k>.md` per drama, the story briefs pre-production
  plans from (one drama per production). Picks the
  mode `drama` / `steamy` / `explicit` from the story and the workspace nudity policy. Do NOT
  invoke for writing a screenplay, cast list or scene list, or for shortening a story without
  serializing it.
agentType: worker
---

# Micro-drama Rewrite

Plain writing task. Tools: `load_skill` (mode `explicit` only: `workflow-calling-conventions`),
`sandbox_write_file` (one call per file: `series.md`, then each `drama_<k>.md`), `task_complete`,
`task_failed`. No renders, no other files. Replies: see "Concise replies and task/artifact URIs"
in `workflow-calling-conventions`.

Nudity policy = the `Workspace content policy (nudity)` line of your task prompt: `allowed`, or
anything else = `forbidden`.

## 0. Preflight (refuse instead of rewriting)

Call `task_failed("PREFLIGHT: <rule>: <one line why>")` and write nothing when:

- the prompt has no source story (empty or a placeholder);
- the source puts a MINOR (a stated age under 18, a school pupil, a child) into a sexual, nude
  or romantic-erotic beat, or a child into a scene with sexual or nude content; never age such a
  character up;
- the source's sexual content is non-consensual (coercion, force, intoxication, sleep) or
  incestuous (step-relations included) at its core.

Everything else is adapted (all characters are fictional): a character stated to be 18 or older
is an adult - raise an age of 18-20 to 21+ and apply section 7. Incest means blood relatives or a
step-parent / step-child / step-sibling; in-laws and a partner's family (a wife's sister, a son's
girlfriend) are not incest.

## 1. Read the source

- **Production directives**: instructions about the film, not events (length, scene or clip caps,
  "children's 2D comic style", "POV throughout", "visible characters only", "must cover the sex
  acts", language, look). Keep and obey every directive; it beats every default below, never
  section 7 or the nudity policy. Length directives: section 3.
- **User wishes** (a `User wishes:` line of the task prompt): override the drama / episode counts,
  lengths and the directives (e.g. "one drama only", "10 episodes"); never section 7 or the
  nudity policy.
- **Workspace look**: the `Workspace style` / `Workspace setting` lines of the task prompt, when
  not empty, are the look and setting.
- **Story**: everything else - its events, cast, places and dialogue are your material.

## 2. Choose the mode (once; the same in every file)

| The story | Policy | Mode |
|---|---|---|
| no sexual content (drama, comedy, mystery, children's story) | any | `drama` |
| sexual content | `forbidden` | `steamy` |
| sexual content | `allowed` | `explicit` |

- Sexual content = the source has a sex scene or a sexual act, shown or only stated ("they sleep
  together" counts; a kiss alone does not).
- Never add sex, nudity or romance heat to a `drama` story; a story for children or with a child
  protagonist is always `drama`.

## 3. Decompose: series -> dramas -> episodes

Never force-compress the source and never pad it. Work in this order:

1. **Turning points**: list every turning point of the source, in order - an event that changes
   the situation: a decision, a reveal, an arrival, a confrontation, a first touch, an act, a
   betrayal, a rescue. One line each. Descriptions, moods and repeated beats are not turning
   points. Turning points come ONLY from the source: never invent events after the source's
   ending (no sequel, no "the rest of the week", no new confrontation) - the open question of
   the last episode is a closing image or line, not new episodes.
2. **Episodes**: each turning point becomes EXACTLY ONE episode (the episode climbs to it and
   ends on its cliffhanger). Never two turning points in one episode, never one turning point
   over two episodes, never an episode without one. The episode count IS the turning-point count.
   Episodes are numbered across the whole series: episode N = turning point N (drama 2 continues
   where drama 1 ended, e.g. episode 9), never restarting at 1 per drama.
3. **Dramas**: cut the list into dramas (below).


- **Drama** = one self-contained arc: ONE core dynamic, ONE obstacle, ONE payoff (section 4). A
  drama ends ONLY at a turning point where its central conflict is RESOLVED - the pair commits or
  splits for good, the secret is out, the case is solved, the threat is beaten. A climax, a sex
  scene or a near miss inside a conflict that still goes on is NOT an end. The next drama starts
  with a new conflict (often after a time jump, or with a new central pair). A source with one
  central conflict is ONE drama - never split it to make more.
- **Decide the dramas first**: before cutting, name each central conflict of the source and the
  turning point that resolves it - one drama per conflict. Then test every boundary: does drama
  k+1 open on a NEW conflict (a new pair, a time jump, a new threat)? If its first episode goes on
  in drama k's scene, act or moment (the same encounter continued, the climax of the same act, its
  aftermath), it is not a new drama - join it to drama k.
- **Length directives**: a length of at most 120 s for one episode ("a 90 s episode") is L. Any
  length over 120 s is the TOTAL of the production, even when the text calls it an episode ("a
  3-5 min short video episode", "about 2:55", "a 3-5 min video"): it is spread over the first
  drama's turning points, L = total / its turning points, kept within 45-120 s. When its turning
  points x 45 s exceed the total, L = 45 s and the total grows - the `Changes from the source` line
  says so ("source total ~2:55 -> ~6:45: one episode per turning point"). Clip or shot lengths
  ("10-15 s clips") are not L. Neither ever cuts a turning point or moves a drama boundary. Only a
  `User wishes` line may ask for fewer dramas or a hard total length.
- **Size**: a drama has at most 12 episodes. A longer run of turning points with ONE central
  conflict stays one drama only if the source gives it no resolution point; otherwise end the
  drama at the turning point that resolves the most and continue with the next drama.
- **Order and continuity**: dramas follow the source's order; the last episode of a drama ends on
  a hook into the next drama (or, for the last drama, an image or line that opens a next season).
  The same character keeps the same name, age and look in every drama.

## 4. Find each drama's spine

- **Core dynamic**: what the audience pays to watch, one line (a mystery to solve, a forbidden
  pairing, rivals, a power exchange). Keep it intact.
- **Obstacle**: what stands between the dynamic and its payoff. Prose often has none (erotica is
  usually setup, one long scene, afterglow): then INVENT one from material the story already has -
  a secret, a spouse, a rival, a deadline, the risk of being caught; prefer pressure from outside
  the main pair. It ACTS on screen in every episode (a knock, a call, a text, a voice on the
  stairs, a car), each time closer, and causes at least one episode's turn.
- **Payoff**: what the spine builds to (`drama`: the reveal or confrontation; `explicit`: the
  source's final or most intense act; `steamy`: the implied consummation). Earlier acts or
  discoveries are rungs.
- **Escalation ladder**: the drama's turning points (section 3), in order, up to the payoff; each
  episode climbs to ONE of them.

## 5. Shape each drama

- **Episodes**: length L = 75 s unless a directive or user wish says otherwise (60-90 s); count =
  the drama's turning points (section 3), at least 2 (a drama with one turning point joins its
  neighbour).
- **Phases of every episode** (relative to L):
  - HOOK, 0-3 s: open mid-tension on a touch, a line or a glance; never on setup or a calm
    establishing shot. The drama's first episode states the core dynamic in its hook or first escalation line.
  - ESCALATION, 3 s to 60% of L: build to the episode's turning point.
  - TURN (complication), 60% of L to L-5 s: a complication or a shift in power.
  - CLIFFHANGER, the last 5 s, one type: `interruption` (knock, call, footsteps), `being watched`
    (a figure in a doorway, "I saw you"), `power flip`, `ultimatum`, `reveal` (ring, camera, true
    identity), `question` (an unanswered question, a new clue). The beat must BE that type.
  - Cut on the interruption or the revelation, never on the payoff.
  - The next episode's hook PICKS UP that cliffhanger (who knocked, what the text said); every
    threat planted (a figure, a shadow, a photo) pays off before the drama ends.
- **Payoff episode** = the LAST episode of the drama (it reaches the turning point that resolves the
  conflict). Its cliffhanger is the consequence - new stakes at once (jealousy, exposure, a third
  party): "consummation, then consequence" - and the hook into the next drama (section 3).
- **Size** (per drama): keep the source's places and its ON-SCREEN characters (who is only heard or mentioned
  stays off the Cast table, section 9). At most ONE new character, only for the obstacle, named by
  a role word, never a first name. Merge
  to at most 4 places unless a directive says otherwise; each episode 1-3 scenes, each scene ONE
  place and ONE continuous time. A directive's cap (scenes, characters, places) wins: episodes then
  reuse scene numbers - never drop a turning point to meet it.

## 6. Prose to screen

- Every inner thought becomes something seen or heard: a line, a text message shown on screen,
  an overheard secret, a hesitation, breathing, hands, an object.
- Voice-over at most one line per episode (keep a narrator the directives ask for).
- Dialogue carries the escalation: short lines, subtext; keep the source's best lines when they
  work spoken - but never a line that breaks section 7.
- 9:16 frame: close-ups, two-shots, single bodies; no wide group scenes.

## 7. Hard rules (any mode, beat every directive and user wish)

- **Adults**: every character in a sexual, nude or romantic beat is 21 or older, stated in Cast.
  No word anywhere in the file - key lines, dialogue, change notes - states, quotes or implies a
  lower age for them (write only the new line, "I'm twenty-four...", never the source's age, not
  even as "rewritten from"; the change note says "ages raised to 21+"). No youth-coded cue for
  them: "girl", any "little" ("little girl", "little slut", "little sister"), school or teen
  references (a student becomes a graduate or gets a job), "old enough to be his daughter",
  childlike body words, virginity framed as innocence or youth. Age gaps between adults may stay.
- **Children**: no romance, nudity or sexual content involves a child or happens in a scene a
  child is in; a children's story keeps its age rating (peril no worse than the source's).
- **Consent**: every sexual beat is clearly wanted by both, on screen; no coercion, intoxication
  or dependence (employer, teacher, carer) used as leverage; a power exchange or kink is
  negotiated and voluntary - the negotiation (a contract, a safeword, a tested boundary) is drama.
- No real or famous people.
- **Nudity policy**: `forbidden` = no nude body, nothing below underwear and no sex act on screen
  (underwear is allowed); a directive to show sex acts is kept as IMPLIED (cut away, aftermath)
  and listed so in `Directives kept`.

## 8. Heat (modes `steamy` / `explicit`)

- The heat is the ENGINE of the plot, not where it ends: break the source's one long scene into
  rungs across episodes.
- `steamy`: tension, touch and dialogue carry it; cut away at the kiss, show the aftermath (a
  dress on the floor, a closed door). No `Sex act:` line.
- `explicit`: every act of the source stays (listed in `Source sex acts`; a directive "cover the
  sex acts" makes dropping one a defect). Each act shown carries plot - a confession mid-scene, a
  power reversal, a name slipping out - and ends on the interruption or revelation; in the payoff
  episode the act may complete, but its last 5 s are still a cliffhanger (usually `reveal` or
  `question`). Name acts and positions exactly as in "Explicit acts and positions" of
  `workflow-calling-conventions` (load it), on the episode's `Sex act:` / `Sex position:` lines.

## 9. Write the files

Plain Markdown, never PDF or DOCX, each file at most 16000 characters (keep every episode block
short: one or two sentences per line). Plan everything BEFORE the first write: the conflicts and
dramas (section 3), every turning point, each drama's episode numbers, L and total. Then write
`series.md` from that plan, then each `drama_<k>.md` with exactly its table row's episodes - the
files never contradict each other. A drama file refused because it contradicts `series.md`: when
the plan was wrong, write `series.md` again with the corrected plan (a changed file is checked
again), then the drama file; never change a drama's episode count without changing `series.md`.
A write that breaks a rule is refused with the list of defects: fix every listed item and write the file again.

`series.md` - the overview, exactly:

```
# <Series title>: micro-drama series

## Adaptation
- Mode: drama | steamy | explicit
- Dramas: <number of dramas>, <total episodes> episodes, ~<total runtime>
- Look: <workspace style, else the directives' look verbatim, else "as in the source">
- Directives kept: <each source directive, one line each; "none">
- Changes from the source: <one line each>

## Cast
<the Cast table and "Heard or mentioned only" line of the drama layout below, for the whole series>

## Turning points
1. <one line> -> drama 1, episode 1 (source: "<3-8 words quoted from the source passage>")
2. <one line> -> drama 1, episode 2 (source: "<...>")
...
9. <one line> -> drama 2, episode 9 (source: "<...>")   (episode = turning point number)

## Dramas
| Drama | File | Episodes | Source part | Central conflict resolved by |
|---|---|---|---|---|
| 1 | drama_1.md | <n> | <which part of the source> | <the turning point that resolves it> |
```

One `drama_<k>.md` per drama (k = 1, 2, ...). Each is SELF-CONTAINED - it becomes the story
pre-production plans from, alone - exactly this layout:

```
# <Series title>, drama <k> of <number of dramas>: <drama title>

## Adaptation
- Mode: drama | steamy | explicit
- Format: vertical 9:16 (portrait), <N> episodes x ~<L> s, total ~<T>
- Previously: <one line: what happened in the dramas before; "none" for drama 1>
- Look: <workspace style, else the directives' look verbatim, else "as in the source">
- Directives kept: <each source directive, one line each; "none">
- Source sex acts: <mode explicit: every act of THIS drama's part of the source; else omit this line>
- Scenes total: <count of distinct S numbers> (cap: <the directive's cap, or none>)
- Changes from the source: <invented obstacle; "ages raised to 21+" (never the old age); cues
  removed; characters / places merged or cut; a new character - one line each>

## Logline
<two sentences: core dynamic + obstacle>

## Spine
- Core dynamic: ...
- Obstacle: ...
- Payoff: ... (episode <n>)
- Escalation ladder: 1. ... 2. ... (the drama's turning points, one per episode)

## Cast
| Name | Role | Age | Look |
|---|---|---|---|
| <the source's name; unnamed in the source = its role: Sister> | ... | <the source's age, 21+ for any sexual / romantic role; none stated: 25+ for such a role, else by role; "toy" for a toy; never "unknown"> | ... |
Heard or mentioned only: <names, or none>

## Places
| Place | INT/EXT | Episodes |
|---|---|---|

## Episodes
### Episode <n>: <title>   (n = its turning point number in series.md)
- Hook: ...
- Escalation: ...
- Turn: ...
- Cliffhanger (<type>): ...
- Key lines: "...", "..."
- Turning point: <its number in series.md>: <one line>
- Sex act: <names joined by " + ">: <who does what to whom>
- Sex position: <ONE name>: <who is where>
- Scenes: S<n> <place> - <one line>; S<n+1> <place> - <one line>

## Drama arc
<payoff episode, the consequence after it, the hook into the next drama>
```

- `Sex act` / `Sex position`: mode `explicit` only - EVERY episode carries the pair, `none` /
  `none` when it shows no act, one pair per act shown (a position change is a new pair); modes
  `drama` / `steamy` never have them.
- `Cast` (per drama): every character SEEN on screen in THIS drama, with exactly the series'
  name, age and look; (animals and toys included). Pre-production designs every
  row, so a character only heard or mentioned is NOT a row (a row whose role or look says voice,
  heard or off-screen is a defect): name them on the `Heard or mentioned only` line.
- Episode numbers: the series numbering (= turning point numbers), so drama 2 starts at the episode
  after drama 1's last; pre-production and the episode cuts keep these numbers.
- `Scenes`: numbers `S1, S2, ...` run across the drama (each drama starts again at S1); an episode that goes on in the previous
  episode's place and moment REUSES the number. `Scenes total` counts the distinct numbers.
- `Places`: on-screen places only.
- Names: the source's own; never rename a character except to fix a rule of section 7. A
  character the source names only by role or label ("Subject 1 (the sister)") is named by the
  ROLE ("Sister", "Husband") - never a new first name.

## Pre-completion audit

Before each file's write, re-read it against sections 0, 2, 3, 5, 7 and 9: every turning point of the
source is listed with its source quote and maps to exactly one episode (episode count =
turning-point count; episode number = turning point number), and no turning point is invented beyond the source's ending; every
drama ends where its central conflict is resolved; each drama is one arc with its own
payoff and is self-contained; the mode; every directive obeyed and each drama's `Scenes total`
within its cap; every Cast name occurs in the source (else a role word) and keeps the same age and
look in every file; every episode has the four phases, a cliffhanger that is its type and a hook
that picks up the previous one; the obstacle acts in every episode of its drama; each drama's
payoff is its last episode and still ends on a cliffhanger; at most 12 episodes per drama; mode `steamy` shows nothing nude or sexual;
mode `explicit` has a `Sex act:` line for every `Source sex acts` entry; NO word breaks section 7;
the `Dramas:` line of `series.md` states the Dramas table's drama count and the turning-point count;
each drama's title line is `# <Series title>, drama <k> of <number of dramas>: <drama title>` and its
`Format:` line is `vertical 9:16 (portrait), <N> episodes x ~<L> s, total ~<T>` with N = its episode
count and L within 45-120 s. Fix, then write. Call `task_complete` only when EVERY file the Dramas
table names is written; a file still missing -> write it first.
