/** Turns a Brief into the workspace YAML the harness opens.
 *
 *  The fragments below are workspace-v11.yaml from ~/auteur, verbatim — the
 *  ~850-line workspace that ran end to end and produced four stylistically
 *  consistent clips plus a film. Almost none of it varies per production: the
 *  skills, workflows, models, policies and agents are the proven part and are
 *  copied here unchanged, so a run from this surface is the same run the harness
 *  author debugged.
 *
 *  The production is split across TWO workspaces, because workspaces are
 *  immutable and unpausable — once opened, tasks auto-dispatch as dependencies
 *  complete, so the human approval gate cannot live inside one workspace:
 *
 *    composePlanningWorkspace(brief)          -> `<slug>@1.0`
 *      the five LLM-only planning tasks (screenplay, cast, scenes, art
 *      direction, visual bible). Runs minutes, costs cents, no GPU.
 *
 *    composeRenderWorkspace(brief, approved)  -> `<slug>-shoot@1.0`
 *      opened ONLY after the user approves the planning output. Contains just
 *      the planner task (schedule_video_renders), whose prompt carries the five
 *      approved documents INLINE — this fresh workspace has no artifacts to
 *      read, so the documents travel as pasted text.
 *
 *  Both composers are pure: same input in, byte-identical YAML out. No clock,
 *  no randomness, no I/O. The slug and seed are the caller's business, which is
 *  what makes a launch reproducible and these functions testable.
 */
import { SCENE_COUNT_MAX, SCENE_COUNT_MIN, SLUG_RE, type Brief } from './types';
import { BASE, formatPicks, type Pick } from './loras';
import { modelFor, textFor, type Overrides } from './tunables';

/** metadata.version, and the half of the workspace id after the `@`.
 *
 *  It stays pinned. Workspaces are immutable once opened and a fresh id is what
 *  buys a fresh run — but the id is `<metadata.name>@<metadata.version>`, so the
 *  uniqueness has to live in the name. Bumping the version here instead would
 *  desync this file from the id the launch endpoint polls. */
/** What a parameterised agent block needs: which model runs it and the system
 *  prompt it runs with. Both come from the tunables registry, so an override in
 *  the admin panel and the shipped default flow through the same path. */
interface AgentTuning {
	model: string;
	prompt: string;
}

/** Everything the template interpolates, resolved once per compose so a single
 *  YAML is always internally consistent. */
function resolveTuning(o?: Overrides) {
	const agent = (id: string): AgentTuning => ({
		model: modelFor(id, o),
		prompt: textFor(id, o)
	});
	return {
		screenwriter: agent('screenwriter'),
		planner: agent('planner'),
		director: agent('director'),
		casting_director: agent('casting_director'),
		generic: agent('generic'),
		prompt_writer: agent('prompt_writer'),
		write_art_direction: textFor('write_art_direction', o),
		write_visual_bible: textFor('write_visual_bible', o)
	};
}

export const WORKSPACE_VERSION = '1.0';

/** The id every planning-phase call addresses this production by. */
export function briefToWorkspaceId(brief: Brief): string {
	return `${brief.slug}@${WORKSPACE_VERSION}`;
}

/** The id of the render workspace — the same production, second act.
 *  The `-shoot` suffix keeps it a sibling of the planning id rather than a
 *  version bump, so both can exist at once and be polled independently. */
export function renderWorkspaceId(brief: Brief): string {
	return `${brief.slug}-shoot@${WORKSPACE_VERSION}`;
}

/** The five approved planning documents, as plain text, exactly as the user
 *  signed them off. `composeRenderWorkspace` pastes each one verbatim into the
 *  planner's prompt under a labelled heading — the render workspace is born
 *  with no artifacts, so these are its only source of truth. */
export interface ApprovedDocs {
	screenplay: string;
	characterTable: string;
	sceneList: string;
	artDirection: string;
	visualBible: string;
}

/** Guardrails on free text. The story cap is not a YAML limit — it is a context
 *  window one: the plot is pasted into the screenwriter prompt and into three
 *  separate policy eval prompts, so a pasted novel fails four times over. */
const STORY_MAX = 50_000;
const TITLE_MAX = 200;
const STYLE_MAX = 500;
const SLUG_MAX = 64;

/** Cap per approved document. All five land inside one planner prompt, which
 *  the planner and the gate policies both have to read. Every model in the
 *  registry declares the same 131k window, so this is a straight budget against
 *  that rather than against the smallest of several. */
const DOC_MAX = 100_000;

/** C0 controls minus the newline we actually want, plus DEL. A YAML scalar
 *  cannot hold any of them.
 *
 *  The lint rule below assumes a control character in a pattern is a typo. Here
 *  they are the subject: this is the class we are stripping, so naming them is
 *  the only way to write it. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Remove what a YAML scalar cannot hold, before any of it is placed in one.
 *  Three separate hazards, none of them theoretical once a user pastes prose out
 *  of a word processor:
 *
 *   - CRLF / lone CR: a stray carriage return inside a block scalar is content,
 *     and resurfaces as a literal ^M in the screenwriter's prompt.
 *   - tabs: YAML forbids a tab in indentation, so a pasted paragraph that starts
 *     with one breaks the document rather than indenting the line.
 *   - C0 controls: not permitted in a YAML scalar at all.
 *
 *  Trailing spaces go too — harmless, but they make the composed YAML noisy to
 *  read in the launch log, which is the only copy that exists when something
 *  goes wrong. */
function scrub(raw: string): string {
	return raw
		.replace(/\r\n?/g, '\n')
		.replace(/\t/g, '    ')
		.replace(CONTROL_CHARS, '')
		.replace(/ +$/gm, '');
}

/** Collapse arbitrary text to a single line. Used for anything that has to sit
 *  on one line of the document: a title inside a quoted scalar, and the style
 *  sentence inside a folded (`>`) block, where a more-indented line would stop
 *  folding and a blank line would split the paragraph in two. */
function oneLine(raw: string): string {
	return scrub(raw).replace(/\s+/g, ' ').trim();
}

/** A YAML double-quoted scalar, escaped. Double-quoted is the one YAML style
 *  with backslash escapes, so a title containing a quote, a colon, a leading `#`
 *  or a `- ` can neither terminate the scalar nor be re-read as structure. */
function yamlDoubleQuoted(raw: string): string {
	return `"${oneLine(raw).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Give a fragment a full stop so it does not run into the sentence after it.
 *  The style line sits in a folded (`>`) scalar, where the director agent reads
 *  the prompt as continuous prose — an unpunctuated fragment arrives there as
 *  "cel-shaded Every frame of every scene". */
function endSentence(raw: string): string {
	return /[.!?:;]$/.test(raw) ? raw : `${raw}.`;
}

/** Prepare arbitrary prose to sit under a `|` literal block scalar.
 *
 *  This helper exists because interpolating text straight into a block scalar
 *  is the one substitution here that can silently produce a *valid* document
 *  that says the wrong thing. A block scalar takes its indentation from its
 *  first non-empty line, and every later line must be at least that deep — so a
 *  paragraph pasted with a leading indent (an email quote, a Word paragraph,
 *  anything that survived a copy out of a PDF) sets a deeper indent than the
 *  rest of the text, and the parser ends the scalar at the first shallower
 *  line. Everything after it is then read as YAML structure: the text is
 *  truncated mid-sentence, or the document fails to parse several hundred lines
 *  later with an error pointing nowhere near the cause.
 *
 *  So: scrub, drop the framing blank lines, remove the common indentation, then
 *  force the first line flush left so auto-detection cannot pick anything but
 *  the indent we are about to apply ourselves. */
function normalizeBlockBody(raw: string): string {
	const lines = scrub(raw).split('\n');
	while (lines.length > 0 && lines[0].trim() === '') lines.shift();
	while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
	if (lines.length === 0) return '';

	const common = Math.min(
		...lines.filter((l) => l !== '').map((l) => (l.match(/^ */) as RegExpMatchArray)[0].length)
	);
	const out = lines.map((l) => l.slice(common));
	if (out[0].startsWith(' ')) out[0] = out[0].trimStart();
	return out.join('\n');
}

/** Indent a normalized body to sit under its `|`. Blank lines stay genuinely
 *  blank: padding them would add trailing whitespace at every paragraph break
 *  for no benefit. */
function indentBlock(raw: string, width: number): string {
	const pad = ' '.repeat(width);
	return normalizeBlockBody(raw)
		.split('\n')
		.map((l) => (l === '' ? '' : pad + l))
		.join('\n');
}

/** Fail loudly and early. The launch endpoint reports a throw from here as
 *  "compose failed", which is the one error that means "our bug, not the
 *  harness" — so every message below says which field and why. */
function assertBrief(brief: Brief, plot: string): void {
	if (typeof brief.slug !== 'string' || !SLUG_RE.test(brief.slug))
		throw new Error(`slug must match ${SLUG_RE} (got ${JSON.stringify(brief.slug)})`);
	if (brief.slug.length > SLUG_MAX) throw new Error(`slug is longer than ${SLUG_MAX} chars`);

	if (typeof brief.title !== 'string' || oneLine(brief.title) === '')
		throw new Error('title is empty');
	if (brief.title.length > TITLE_MAX) throw new Error(`title is longer than ${TITLE_MAX} chars`);

	if (typeof brief.story !== 'string' || plot === '') throw new Error('story is empty');
	if (brief.story.length > STORY_MAX) throw new Error(`story is longer than ${STORY_MAX} chars`);

	if (typeof brief.style !== 'string' || oneLine(brief.style) === '')
		throw new Error('style is empty');
	if (brief.style.length > STYLE_MAX) throw new Error(`style is longer than ${STYLE_MAX} chars`);

	if (!Number.isInteger(brief.sceneCount))
		throw new Error(`sceneCount must be a whole number (got ${brief.sceneCount})`);
	if (brief.sceneCount < SCENE_COUNT_MIN || brief.sceneCount > SCENE_COUNT_MAX)
		throw new Error(
			`sceneCount must be ${SCENE_COUNT_MIN}..${SCENE_COUNT_MAX} (got ${brief.sceneCount})`
		);

	// The seed is written as a bare YAML number, so it has to be one that
	// survives the round trip: a fractional value would re-read as a float, and
	// anything past 2^53 had already lost digits before it got here.
	if (!Number.isSafeInteger(brief.seed) || brief.seed < 0)
		throw new Error(`seed must be a non-negative whole number (got ${brief.seed})`);
}

/** Same contract as assertBrief, for the second launch: refuse to compose a
 *  render workspace around a document that is missing or would blow the gate
 *  policies' context window. `approved` here means "the user clicked yes", not
 *  "the text survived a copy-paste" — this is the check for the latter. */
function assertApprovedDocs(docs: ApprovedDocs): void {
	if (!docs || typeof docs !== 'object') throw new Error('approved documents are missing');
	const entries: [keyof ApprovedDocs, string][] = [
		['screenplay', 'screenplay'],
		['characterTable', 'character table'],
		['sceneList', 'scene list'],
		['artDirection', 'art direction'],
		['visualBible', 'visual bible']
	];
	for (const [key, label] of entries) {
		const value = docs[key];
		if (typeof value !== 'string' || normalizeBlockBody(value) === '')
			throw new Error(`approved ${label} is empty`);
		if (value.length > DOC_MAX)
			throw new Error(`approved ${label} is longer than ${DOC_MAX} chars`);
	}
}

/* ── proven fragments, verbatim from workspace-v11.yaml ─────────────────────
 * Each constant is a complete YAML block at its final indentation, so the two
 * composers can assemble documents by joining fragments with blank lines.
 * Nothing in this section varies per production. */

const SKILLS_BLOCK = `  skills:
    - modify-policy@mvp-lkg
    - workflow-render-loop@mvp-lkg
    - shoot-single-scene@mvp-lkg
    - art-direction-writer@mvp-lkg
    - visual-bible-writer@mvp-lkg
    - scene-assembler@mvp-lkg
    - prompt-writer-wan22@mvp-lkg
    - prompt-writer-krea2@mvp-lkg
    - prompt-writer-flux3@mvp-lkg
    - prompt-writer-minimaxh3@mvp-lkg`;

const WORKFLOWS_BLOCK = `  workflows:
    - name: krea2_base_realism
      url: krea2_base_realism@mvp-lkg
    - name: minimaxh3_t2v_i2v_ref2v_advanced_film_making_foxydit
      url: minimaxh3_t2v_i2v_ref2v_advanced_film_making_foxydit@dszabo`;

function profilesBlock(seed: number): string {
	// steps=4 because that is what the workflow is built around: it ships a
	// LightX2V 4-step turbo LoRA, and its own notes put steps=4 at 2-4 minutes a
	// clip against 10-18 at steps=8. We were on 8, and measured 7-9 minutes a clip
	// — which is the slow path, not a better one. 6-10 also work, so 8 was valid;
	// it just paid three times the render time for a LoRA it was bypassing.
	//
	// gpuType is inert here: the workflow bundle declares its own gpu_types and
	// those win. It stays because the profile schema wants a value — but it says
	// a100 rather than l40s now, because l40s is not merely unused, it cannot run
	// this workflow at all. Its SageAttention kernels are sm_80 only, so l40s
	// (sm_89) and h100 (sm_90) both die in the sampler and a100 is the one card
	// that works. Leaving a dead card named here invites someone to trust it the
	// day the bundle stops overriding.
	//
	// fps=48 is not a preference, it is the workflow's arithmetic. The model
	// renders at 24fps native and a RIFE pass doubles the frames, so 48 is the
	// rate at which the clip lasts as long as it was asked to. We had 30, which
	// wrote the same frames slower: a six-second clip came back at 10.5s, an
	// exact 48/30 stretch — and the audio, generated for the six, drifted out
	// from under a picture running 1.6x long. The same prompt in ComfyUI, where
	// the port keeps its default, sounded right.
	return `  profiles:
    draft:
      image: { width: 720, height: 480, steps: 4, seed: ${seed} }
      video: { width: 720, height: 480, steps: 4, fps: 48, seed: ${seed} }
      audio: { sampleRate: 16000 }
      compute: { backend: modal, gpuType: a100, timeoutSec: 1800, maxAttempts: 2 }`;
}

/** The model registry.
 *
 *  The key is written onto each model rather than left to the harness, because
 *  on the worker path there is nothing to leave it to. GrokBackend takes its
 *  Authorization header from `model.apiKeys.token` and nowhere else, and the
 *  only code that fills that from config is WorkspaceAgent.resolveApiKey — the
 *  manager's path. WorkerAgent's injection is hard-gated on
 *  `provider === "ollama"`, so a grok model declared here reaches the backend
 *  with no token and the call comes back "401 no credentials presented".
 *
 *  Not fixable from golem.yaml: the deployer answers an added grokApiKey with
 *  "Ignoring unused config keys for agent WorkerAgent", because the compiled
 *  agent-type metadata declares that key on WorkspaceAgent only. The component's
 *  own JSDoc documents this shape — "Required: model.apiKeys.token" — so this is
 *  the intended channel rather than a trick.
 */
function modelsBlock(grokKey: string): string {
	return `  # Model registry. The key travels on each model — see modelsBlock() for why.
  #
  # Everything runs on Grok because everything has to read the content: the
  # writers produce it, and the gate policies judge it. Every Ollama Cloud model
  # refuses explicit material outright, and refuses it invisibly — the worker
  # writes nothing, calls task_complete, the gate says "no files produced", and
  # the harness retries forever.
  #
  # grok-4.5 rather than 4.6, which was the obvious pick and the wrong one: 4.6
  # refuses the same prompts the Ollama models refused, and is three times slower
  # on ordinary work (29.6s vs 8.3s measured). 4.3 also works and is the
  # alternative.
  models:
    - id: grok-4-5
      name: "Grok 4.5 (xAI)"
      provider: grok
      model: "grok-4.5"
      endpoint: "https://api.x.ai/v1"
      apiKeys:
        token: ${yamlDoubleQuoted(grokKey)}
      streaming: false
      reasoningEffort: default
      temperature: 0.7
      capabilities:
        - chat
        - tools
      settings:
        contextWindow: 131072

    - id: grok-fast
      name: "Grok 4.20 non-reasoning (xAI)"
      provider: grok
      model: "grok-4.20-0309-non-reasoning"
      endpoint: "https://api.x.ai/v1"
      apiKeys:
        token: ${yamlDoubleQuoted(grokKey)}
      streaming: false
      reasoningEffort: default
      temperature: 0.4
      capabilities:
        - chat
        - tools
      settings:
        contextWindow: 131072

    - id: grok-4-3
      name: "Grok 4.3 (xAI)"
      provider: grok
      model: "grok-4.3"
      endpoint: "https://api.x.ai/v1"
      apiKeys:
        token: ${yamlDoubleQuoted(grokKey)}
      streaming: false
      reasoningEffort: default
      temperature: 0.4
      capabilities:
        - chat
        - tools
      settings:
        contextWindow: 131072`;
}

const POLICY_SCREENPLAY_QUALITY = `    screenplay-quality:
        id: screenplay-quality
        description: "Screenplay faithfully adapts the source story with proper formatting"
        model: grok-4-5
        modality: text
        grading: Binary
        evalPrompt: >
          Does the following screenplay faithfully adapt the original story plot, tropes and emotions
          with proper screenplay format (INT./EXT. scene headings, action lines,
          dialogue blocks)? Answer YES or NO only.

          # Screenplay:

          {input}

          # Original story:

          {workspace.story.plot}`;

const POLICY_CAST_QUALITY = `    cast-quality:
        id: cast-quality
        description: "Cast list accurately reflects characters and captures their essence"
        model: grok-4-5
        modality: text
        grading: Binary
        evalPrompt: >
          You are reviewing a cast breakdown list against the original story.

          STEP 1 — From the original story, enumerate every character who would require
          a cast entry in a film production: speaking characters, named roles, and
          characters with a meaningful presence in the story. Background references,
          unnamed walk-ons, and animals or objects serving as environmental props or
          set dressing are NOT cast roles — do not include them.

          STEP 2 — For every character you identified in STEP 1, verify the cast list
          contains a dedicated entry with physical details and personality notes.
          A character that appears only as a passing mention in another character's
          entry does NOT count as a dedicated profile.

          Answer YES only if every character from STEP 1 has a complete dedicated
          profile. Answer NO and name the missing characters if any are absent or
          lack a full entry. Answer YES or NO only.

          # Cast list:

          {input}

          # Original story:

          {workspace.story.plot}`;

const POLICY_SCENES_QUALITY = `    scenes-quality:
        id: scenes-quality
        description: "Scene breakdown covers all narrative beats with clear location and action"
        model: grok-4-5
        modality: text
        grading: Binary
        evalPrompt: >
          Does the following scene breakdown cover all narrative beats and key moments of the original story
          with numbered scenes, INT/EXT designations, locations,
          and one-sentence action summaries? Answer YES or NO only.

          # Scene list:

          {input}

          # Original story:

          {workspace.story.plot}`;

const POLICY_ENSURE_TASKS_CREATED = `    ensure-tasks-created:
        id: ensure-tasks-created
        description: "Make sure all tasks identified by a planner have been created and scheduled for processing"
        model: grok-4-5
        modality: text
        grading: Binary
        evalPrompt: >
          Review the tool calls below. Compute the NET FINAL STATE by applying all
          create_task, delete_task, create_artifact, and delete_artifact calls in order.
          A task is "live" if it was created and never subsequently deleted.
          An artifact is "live" if it was created and never subsequently deleted.

          Answer YES if ALL of the following are true in the NET FINAL STATE, otherwise NO:
          - At least one live task exists
          - Every live artifact's task_id refers to a live task
          - No live artifact references a task_id that belongs to a deleted or never-created task

          Ignore deleted tasks and deleted artifacts entirely — only the final state matters.
          Answer YES or NO only.

          # tool calls:
          {toolCalls}

          # session transcript (context only):
          {input}`;

/** The proven coverage gate, as the planning workspace carries it: the scene
 *  count comes from the approved scene_list artifact via {artifactIndex}. Only
 *  valid where that artifact exists — the render workspace gets the
 *  {task.prompt} variant below instead. */
const POLICY_RENDER_COVERAGE_FROM_ARTIFACTS = `    ensure-render-covers-all-scenes:
        id: ensure-render-covers-all-scenes
        description: "Verifies render tasks were scheduled for every scene in the approved scene list without skipping any."
        model: grok-4-5
        modality: text
        grading: Binary
        evalPrompt: >
          The planner must schedule render tasks for every scene in the approved scene list — one per scene,
          no skipping. The scene list artifact is the ground truth for how many scenes exist.

          STEP 1 — From the artifact index, find the approved artifact that is designated as and contains the scene list.
          If it is missing or not approved, answer NO.
          Count the distinct numbered scenes in its content. Let TOTAL = that count.
          If TOTAL == 0, answer NO.

          STEP 2 — From the create_task calls in the tool calls, extract all distinct scene
          identifiers (e.g. "S1", "S2", "S3", "S4", "Scene 1", "Scene 2", "scene 3", etc.)
          that appear in task titles or descriptions.
          Let COVERED = the number of distinct scenes that received at least one render task.

          STEP 3 — Answer YES only if COVERED >= TOTAL.
          Answer NO if COVERED < TOTAL — meaning at least one scene has no render task scheduled.
          Answer YES or NO only.

          # artifact index (ground truth — approved scene_list):
          {artifactIndex}

          # tool calls (name + args):
          {toolCalls}

          # session transcript (context only):
          {input}`;

/** The same coverage gate, rewritten for the render workspace. That workspace
 *  is born with an EMPTY artifact index — the scene list travels inline in the
 *  planner's prompt — so counting scenes via {artifactIndex} would answer NO
 *  forever and block dispatch. The ground truth here is {task.prompt}. */
const POLICY_RENDER_COVERAGE_FROM_PROMPT = `    ensure-render-covers-all-scenes:
        id: ensure-render-covers-all-scenes
        description: "Verifies render tasks were scheduled for every scene in the scene list embedded in the planner prompt without skipping any."
        model: grok-4-5
        modality: text
        grading: Binary
        evalPrompt: >
          The planner must schedule render tasks for every scene in the approved scene list — one per scene,
          no skipping. The approved scene list is embedded verbatim in the planner task's
          prompt, under the heading "APPROVED SCENE LIST". That embedded list is the
          ground truth for how many scenes exist. This workspace has no scene list
          artifact — do not look for one, and do not answer NO because the artifact
          index is empty.

          STEP 1 — In the task prompt below, find the section headed "APPROVED SCENE LIST"
          and count the distinct numbered scenes it contains. Let TOTAL = that count.
          If the section is missing or TOTAL == 0, answer NO.

          STEP 2 — From the create_task calls in the tool calls, extract all distinct scene
          identifiers (e.g. "S1", "S2", "S3", "S4", "Scene 1", "Scene 2", "scene 3", etc.)
          that appear in task titles or descriptions.
          Let COVERED = the number of distinct scenes that received at least one render task.

          STEP 3 — Answer YES only if COVERED >= TOTAL.
          Answer NO if COVERED < TOTAL — meaning at least one scene has no render task scheduled.
          Answer YES or NO only.

          # task prompt (ground truth — contains the approved scene list):
          {task.prompt}

          # tool calls (name + args):
          {toolCalls}

          # session transcript (context only):
          {input}`;

const POLICY_RENDER_TASKS_HAVE_ARTIFACTS = `    ensure-render-tasks-have-artifacts:
        id: ensure-render-tasks-have-artifacts
        description: "Every render task created by the scheduler must have at least one artifact registered"
        model: grok-4-5
        modality: text
        grading: Binary
        evalPrompt: >
          Review the tool calls below. For each create_task call, there must be at least
          one create_artifact call whose task_id argument matches that task's returned id.

          STEP 0 — If there are zero create_task calls, answer NO immediately. A planner
                    that created no tasks has not satisfied the artifact requirement.

          STEP 1 — List all create_task calls and the id each returned.
          STEP 2 — List all create_artifact calls and the task_id each was given.
          STEP 3 — For every task from STEP 1, check that at least one entry from STEP 2
                    uses its id as task_id.

          Answer YES if every created task has at least one artifact. Answer NO if any
          created task has no matching create_artifact call, or if no tasks were created at all.
          Answer YES or NO only.

          # tool calls (name + args + return values):
          {toolCalls}

          # session transcript (context only):
          {input}`;

const AGENT_SCREENWRITER = (a: AgentTuning) => `    screenwriter:
      id: screenwriter
      name: "Screenwriter"
      model: ${a.model}
      role: "Screenwriter"
      objective: "Adapt literary source material into properly formatted short-film screenplays"
      systemPrompt: >
${indentBlock(a.prompt, 8)}
      readOnly: false`;

const AGENT_PLANNER = (a: AgentTuning) => `    planner:
      id: planner
      name: "Planner"
      model: ${a.model}
      role: "Multi-step planner and problem solver"
      objective: "Analyze a complex task, break it down into individual steps."
      systemPrompt: >
${indentBlock(a.prompt, 8)}
      policies:
        - ensure-tasks-created
      readOnly: false`;

const AGENT_DIRECTOR = (a: AgentTuning) => `    director:
      id: director
      name: "Director"
      model: ${a.model}
      role: "Director"
      objective: "Shape the creative vision and ensure narrative coherence across all production materials"
      systemPrompt: >
${indentBlock(a.prompt, 8)}
      readOnly: false`;

const AGENT_CASTING_DIRECTOR = (a: AgentTuning) => `    casting_director:
      id: casting_director
      name: "Casting Director"
      model: ${a.model}
      role: "Casting Director and Script Supervisor"
      objective: "Generate a concise, production-ready Character Breakdown Sheet based on the provided character details"
      systemPrompt: >
${indentBlock(a.prompt, 8)}
      readOnly: false`;

const AGENT_GENERIC = (a: AgentTuning) => `    generic:
      id: generic
      name: "Production Assistant"
      model: ${a.model}
      role: "Production Assistant"
      objective: "Support the production with research, organization, and general creative tasks"
      systemPrompt: >
${indentBlock(a.prompt, 8)}
      readOnly: false`;

const AGENT_PROMPT_WRITER = (a: AgentTuning) => `    # specific agent & model def. to be used by prompt enhancing tools available to workers
    prompt_writer:
      id: prompt_writer
      name: "Prompt Writer"
      model: ${a.model}
      role: "Workflow-aware prompt writer"
      objective: "Workflow-aware prompt writer and enhancer. Used by draft_prompt, enhance_prompt, review_prompt tools"
      systemPrompt: >
${indentBlock(a.prompt, 8)}
      readOnly: false`;

/** Fill the style hole in the art-direction prompt.
 *
 *  The prompt names the production's one binding visual medium and then shows
 *  `${style}` where that medium belongs — but the substitution was never
 *  written. The agent read the placeholder as literal text and invented a
 *  medium from the screenplay instead, so a brief asking for "handheld
 *  smartphone amateur video with visible noise and tight shaky close framing"
 *  came back as "35mm film photograph, fine organic film grain, naturalistic
 *  independent-cinema look" — and every render prompt pasted that in verbatim.
 *  The style the user typed reached no agent at all.
 *
 *  Replaced through a function rather than a string: the style is the user's
 *  own sentence, and a `$&` or `$'` inside it would otherwise be read as a
 *  replacement pattern instead of as text.
 *
 *  Throws if the hole is gone, which only an admin override can do. Dropping
 *  the style in silence is the bug being fixed here; a launch that stops and
 *  says so leaves something to fix. */
function fillStyle(prompt: string, style: string): string {
	const filled = prompt.replaceAll('${style}', () => style);
	if (!filled.includes(style))
		throw new Error(
			'the art direction prompt has no ${style} placeholder — the production style has nowhere to go'
		);
	return filled;
}

/** The five planning tasks, verbatim from the proven template. Two holes:
 *  the scene count in create_scenes and the style sentence in
 *  write_art_direction. The schedule_video_renders task is deliberately absent
 *  — it lives in the render workspace, behind the approval gate. */
function planningTasksBlock(
	sceneCount: number,
	style: string,
	tuned: ReturnType<typeof resolveTuning>
): string {
	return `  tasks:
    - id: write_screenplay
      title: "Write Screenplay"
      description: "Adapt the provided original story into a short film screenplay."
      agent: screenwriter
      prompt: >
        Adapt the following original story into a rich film screenplay.

        Story:
        {workspace.story.plot}
      artifacts:
        - id: screenplay
          name: "Screenplay"
          description: "Full screenplay adaptation of the original story"
          files:
            - name: screenplay.md
          policies:
            - screenplay-quality

    - id: character_table
      title: "Create Cast List"
      description: "Create a detailed character breakdown table of main characters and roles."
      agent: casting_director
      requires:
        tasks:
          - write_screenplay
        artifacts:
          - screenplay
      prompt: >
        Read and understand the screenplay artifact and create a rich and detailed character breakdown for all cast roles.
        Rules:
        - identify all characters who appear as cast roles in the screenplay: speaking characters, named roles, and characters with a meaningful presence in the story
        - for each cast role write a character breakdown table in markdown format
        - for each character: write the file with sandbox_write_file, then immediately call add_artifact_file(filename, path=...) to register it

      artifacts:
        - id: character_table
          name: "Character Breakdown Table"
          description: "Character breakdowns and casting notes for all characters and roles"
          policies:
            - cast-quality

    - id: create_scenes
      title: "Create Scene List"
      description: "Break the screenplay into a numbered scene list with location and action summaries."
      agent: director
      requires:
        tasks:
          - write_screenplay
          - character_table
        artifacts:
          - screenplay
      prompt: >
        Based on the approved screenplay, and character breakdowns create a numbered scene
        breakdown. For each scene provide:
        - Scene number
        - INT. or EXT.
        - Location name
        - Time of day (DAY / NIGHT / DUSK etc.)
        - A one-sentence action summary that captures the storytelling and specific action
        - List of involved characters in that scene
        Format as a structured markdown table.

        This is a short film. Produce exactly ${sceneCount} scenes for a total final film duration of 1-5mins
      artifacts:
        - id: scene_list
          name: "Scene List"
          description: "Numbered scene breakdown with location and action summaries"
          files:
            - name: scene_list.md
          policies:
            - scenes-quality

    - id: write_art_direction
      title: "Write Art Direction"
      description: "Define the single visual language for the whole film — era, palette, lensing, lighting, and what is forbidden."
      agent: director
      # Waits for the screenplay and nothing else. It used to wait for
      # create_scenes too, which cost about two and a half minutes of wall clock
      # for nothing: this prompt names the style and reads the screenplay, and
      # never asks for a scene list. It now runs alongside the cast list rather
      # than behind it.
      requires:
        tasks:
          - write_screenplay
        artifacts:
          - screenplay
      prompt: >
${indentBlock(fillStyle(tuned.write_art_direction, style), 8)}
      artifacts:
        - id: art_direction
          name: "Art Direction"
          description: "The authoritative visual language guide for the production"
          files:
            - name: art_direction.md

    - id: write_visual_bible
      title: "Write Visual Bible"
      description: "Turn cast, scenes and art direction into fixed prompt anchors — one per character, one per location."
      agent: generic
      # create_scenes is here because the prompt tells this task to read the
      # scene list, and it was not among its dependencies. Harmless while
      # everything ran in one line — scenes always finished first — but the
      # moment art direction stopped waiting for them it became a race.
      requires:
        tasks:
          - write_art_direction
          - character_table
          - create_scenes
        artifacts:
          - art_direction
      prompt: >
${indentBlock(tuned.write_visual_bible, 8)}
      artifacts:
        - id: visual_bible
          name: "Visual Bible"
          description: "Canonical prompt anchors for every character and location"
          files:
            - name: visual_bible.json`;
}

/** The render workspace's single declared task. Differences from the proven
 *  original are exactly the ones the two-workspace split forces:
 *
 *   - no requires.tasks — the planning tasks do not exist in this workspace,
 *     and referencing an undeclared task is a validation error.
 *   - prompt is a literal (`|`) block that carries the five approved documents
 *     inline under labelled headings, instead of telling the planner to read
 *     artifacts that are not there.
 *
 *  The visual-consistency rules are kept verbatim; the coverage gate reads the
 *  scene list out of this same prompt (see POLICY_RENDER_COVERAGE_FROM_PROMPT). */
function renderPlannerTaskBlock(docs: ApprovedDocs, hasReferenceMaterial: boolean): string {
	// Said only when it is true. A standing instruction to look for reference
	// material would send every planner hunting for an artifact that usually is
	// not there, and a planner that cannot find what it was told to expect
	// tends to invent a reason rather than move on.
	const refClause = hasReferenceMaterial
		? `

        One artifact IS present: \`user_reference_material\`, holding files the
        user supplied for this production. Read its file descriptions. Where a
        file matches a character or location in a scene, say so in that scene's
        shooting task and instruct the worker to pass it to the render workflow
        as reference input — minimax accepts reference-to-video. Nobody can look
        at these files, including you: the descriptions are all there is.`
		: '';
	const doc = (raw: string) => indentBlock(raw, 8);
	return `  tasks:
    - id: schedule_video_renders
      title: "Schedule video shooting tasks"
      description: "Schedule one film shooting task per scene — each renders a ~5-15 second video clip from the scene description using MiniMax H3."
      agent: planner
      reasoningEffort: medium
      policies:
        - ensure-render-covers-all-scenes
        - ensure-render-tasks-have-artifacts
      prompt: |
        The five approved planning documents for this production are embedded below,
        verbatim, under the headings APPROVED SCREENPLAY, APPROVED CHARACTER TABLE,
        APPROVED SCENE LIST, APPROVED ART DIRECTION and APPROVED VISUAL BIBLE.
        There are no planning artifacts to read — the embedded documents are the
        ground truth for the story.${refClause}

        Schedule ONE film shooting task per scene in the APPROVED SCENE LIST below.
        Each scene becomes ONE video clip rendered by the minimax workflow.

        Set video_length to 6 seconds on every render unless a scene genuinely
        cannot be read in that time. Render cost is close to linear in duration,
        and "5-15 seconds" left to judgement came back as fifteen every time —
        three times the wait for a beat that plays in six.

        # BEFORE YOU FINISH — count and check:
        Count the numbered scenes in the APPROVED SCENE LIST. Count the tasks you
        created and the artifacts you registered. All three numbers must be equal.
        If they are not, fix it before completing — do not finish a partial plan
        intending to extend it, you will not get the chance.

        # REGISTER AN ARTIFACT FOR EVERY TASK — this is what the gate checks:
        For each scene, call create_task first, then immediately call
        create_artifact(task_id=<the id that call returned>) for the clip that task
        will produce. One artifact per shoot task, holding that scene's mp4. A task
        with no artifact fails the gate and the whole shooting plan is rejected.

        Your standing instructions warn against a 1:1 task-per-artifact mapping and
        tell you to batch files into one artifact. That is about files within a
        scene, not about scenes: here one task produces one clip, so one artifact
        each is correct and required. Do not group several scenes into one artifact.

        # Instructions when generating task descriptions:
        - use shoot-scene skill
        - determine and state the number of cuts based on the scene descriptions
        - use the APPROVED CHARACTER TABLE below to consistently reference and describe subjects in prompts across scenes
        - one task per scene with one output clip per scene

        # VISUAL CONSISTENCY — the single most important rule:
        - every shooting task description MUST paste in, verbatim, the style block from
          the APPROVED VISUAL BIBLE below, plus the anchor of every character and every
          location that appears in that scene. Copy the anchor text exactly — do not
          paraphrase, shorten or "improve" it. Identical wording across scenes is the
          whole point.
        - state the APPROVED ART DIRECTION's FORBIDDEN list in every task so no scene
          drifts into a different medium.
        - do NOT let each task choose its own resolution, fps or step count — the
          render profile governs those. Say so explicitly in the task description.
        - assign every shooting task to the agent whose id is exactly: generic
          That is the id, not a description — the registry holds three agents
          (planner, generic, prompt_writer) and any other name is rejected.

        # APPROVED SCREENPLAY

${doc(docs.screenplay)}

        # APPROVED CHARACTER TABLE

${doc(docs.characterTable)}

        # APPROVED SCENE LIST

${doc(docs.sceneList)}

        # APPROVED ART DIRECTION

${doc(docs.artDirection)}

        # APPROVED VISUAL BIBLE

${doc(docs.visualBible)}`;
}

/** Compose the planning workspace document for one production: the proven
 *  template minus schedule_video_renders. Everything else — skills, workflows,
 *  models, policies, agents — is kept even where this workspace does not use
 *  it: workflows are lazy and no task here renders, so the unused parts cost
 *  nothing and the document stays diffable against workspace-v11.yaml.
 *
 *  Throws on an unusable Brief rather than emitting a document that would be
 *  rejected — or worse, accepted with a truncated story. Opening a workspace
 *  burns its id for good, so the cheap validation happens here first. */
export function composePlanningWorkspace(
	brief: Brief,
	overrides?: Overrides,
	/** Written into every model's apiKeys.token. Required on the worker path —
	 *  see modelsBlock(). Empty produces a workspace that opens and then fails
	 *  every task with 401, so the caller checks before composing. */
	grokKey = ''
): string {
	const tuned = resolveTuning(overrides);
	if (!brief || typeof brief !== 'object') throw new Error('brief is missing');

	// Both free-text holes are computed before the template so the document below
	// stays readable: `plot` arrives already indented to sit under `plot: |`, and
	// `style` is guaranteed to be one line at the folded block's own indent.
	const plot = indentBlock(typeof brief.story === 'string' ? brief.story : '', 6);
	assertBrief(brief, plot);
	const style = endSentence(oneLine(brief.style));

	return `version: "1.0"
kind: Workspace
metadata:
  name: "${brief.slug}"
  author: studio
  version: "${WORKSPACE_VERSION}"

spec:
  id: "${brief.slug}"
  description: ${yamlDoubleQuoted(brief.title)}
  # Required since the HITL release. We run no HITL tasks, but the field is
  # declared required at the spec level, so it is cheaper to name a model than
  # to find out at open-workspace.
  defaultTaskModel: grok-fast

  story:
    plot: |
${plot}
    tropes: # optional
      # - hero

    emotions: # optional
      - The culprit is the client
      - Damsel-or-monster binary dissolved into hero
      - Projection onto object

${SKILLS_BLOCK}

${WORKFLOWS_BLOCK}

${profilesBlock(brief.seed)}

${modelsBlock(grokKey)}

  policies:
${POLICY_SCREENPLAY_QUALITY}

${POLICY_CAST_QUALITY}

${POLICY_SCENES_QUALITY}

${POLICY_ENSURE_TASKS_CREATED}

${POLICY_RENDER_COVERAGE_FROM_ARTIFACTS}

${POLICY_RENDER_TASKS_HAVE_ARTIFACTS}

  # Agent registry — keyed by agent ID.
  agents:
${AGENT_SCREENWRITER(tuned.screenwriter)}

${AGENT_PLANNER(tuned.planner)}

${AGENT_DIRECTOR(tuned.director)}

${AGENT_CASTING_DIRECTOR(tuned.casting_director)}

${AGENT_GENERIC(tuned.generic)}

${AGENT_PROMPT_WRITER(tuned.prompt_writer)}

${planningTasksBlock(brief.sceneCount, style, tuned)}
`;
}

/** Compose the render workspace document — opened only after the user approves
 *  the planning output. One declared task (the planner), the approved documents
 *  pasted inline into its prompt, and the coverage gate rewritten to read the
 *  scene list from that prompt rather than from an artifact index this
 *  workspace will never have. shoot_* tasks are created dynamically by the
 *  planner; final assembly is triggered by the page over chat, so neither
 *  appears here. */
export function composeRenderWorkspace(
	brief: Brief,
	approved: ApprovedDocs,
	overrides?: Overrides,
	grokKey = '',
	/** Whether reference files will be imported into this workspace once it is
	 *  open. Known at compose time because they are staged before launch, and it
	 *  has to be known here: the planner is otherwise told there are no
	 *  artifacts to read, which stops being true the moment one is imported —
	 *  and the cost of that lie is the user's attached files going unused. */
	hasReferenceMaterial = false
): string {
	const tuned = resolveTuning(overrides);
	if (!brief || typeof brief !== 'object') throw new Error('brief is missing');

	const plot = indentBlock(typeof brief.story === 'string' ? brief.story : '', 6);
	assertBrief(brief, plot);
	assertApprovedDocs(approved);

	return `version: "1.0"
kind: Workspace
metadata:
  name: "${brief.slug}-shoot"
  author: studio
  version: "${WORKSPACE_VERSION}"

spec:
  id: "${brief.slug}-shoot"
  description: ${yamlDoubleQuoted(`${brief.title} — render`)}
  # Required since the HITL release. We run no HITL tasks, but the field is
  # declared required at the spec level, so it is cheaper to name a model than
  # to find out at open-workspace.
  defaultTaskModel: grok-fast

  story:
    plot: |
${plot}

${SKILLS_BLOCK}

${WORKFLOWS_BLOCK}

${profilesBlock(brief.seed)}

${modelsBlock(grokKey)}

  policies:
${POLICY_ENSURE_TASKS_CREATED}

${POLICY_RENDER_COVERAGE_FROM_PROMPT}

${POLICY_RENDER_TASKS_HAVE_ARTIFACTS}

  # Agent registry — keyed by agent ID.
  agents:
${AGENT_PLANNER(tuned.planner)}

${AGENT_GENERIC(tuned.generic)}

${AGENT_PROMPT_WRITER(tuned.prompt_writer)}

${renderPlannerTaskBlock(approved, hasReferenceMaterial)}
`;
}

/** @deprecated The wizard-era single-workspace composer. It is the planning
 *  composer under its old name, kept so nothing breaks mid-integration —
 *  callers should move to composePlanningWorkspace / composeRenderWorkspace. */
export const composeWorkspace = composePlanningWorkspace;

/** Direct mode: your prompt, the GPU, nothing in between.
 *
 *  The planning chain exists to turn one sentence into a film, and it is good at
 *  that. It is the wrong tool when you already know the shot. Measured on a real
 *  run, the chain handed the renderer 1125 words whose first 4389 characters were
 *  appearance and set description — the act itself began 34% in — and what came
 *  back was a portrait of the woman it had spent those words describing. The
 *  model's own prompt guide asks for 350-500 words.
 *
 *  So this workspace has no screenwriter, no casting director, no scene list, no
 *  art direction, no visual bible, no scheduler — and, deliberately, no
 *  prompt_writer. Nothing rewrites what you typed. One task per clip, each
 *  calling the workflow with your text as prompt_positive, verbatim.
 *
 *  The trade is the one the harness author named: with no prompt writer in the
 *  path, the format is yours to get right. That is the point — you are holding
 *  the pen.
 */
export interface DirectSpec {
	slug: string;
	title: string;
	/** One per clip, sent unchanged. */
	prompts: string[];
	seconds: number;
	width: number;
	height: number;
	seed: number;
	/** The adapters this clip asked for, on top of the always-loaded set. */
	loras?: Pick[];
	/** Per-clip strengths for the always-loaded adapters, where you moved one. */
	baseLoras?: Record<string, number>;
	/** How many reference images were staged for this clip. Zero builds exactly
	 *  the graph that existed before references were possible. */
	refImages?: number;
	/** The staged basenames, in order — `ref_0.png`, `ref_1.png` … Only their
	 *  presence matters to the workspace now; the bundle derives the port names
	 *  from the same list server-side. */
	refNames?: string[];
	/** A presigned S3 GET url per reference, same order.
	 *
	 *  These are what the render actually loads. The staged copies on this disk
	 *  are for us to look at; a Modal GPU cannot reach this machine, and the
	 *  harness rejects localhost and RFC-1918 addresses outright rather than
	 *  letting the failure surface an hour later on the worker. */
	refUrls?: string[];
	/** The kept character sheet this clip is shot with, if you picked one. The id
	 *  is resolved server-side into bytes and staged as the first reference, so
	 *  the face is the same one every other clip with this character has. */
	characterId?: string;
	/** Its name, for the task text and the render log — the id means nothing to
	 *  anyone reading either. */
	characterName?: string;
	/** The kept location this clip is shot in, staged as a reference after the
	 *  character. */
	locationId?: string;
	locationName?: string;
	/** What the writer chose before anyone touched the card, and what you typed
	 *  to get it. Neither reaches the workspace — they are here so the launch can
	 *  write down what was tried, and so a card you corrected is recorded as a
	 *  correction rather than as the writer having been right all along. */
	wroteLoras?: Pick[];
	request?: string;
	/** Where the harness should fetch the generated bundle from — this app, at
	 *  the name Docker knows it by. Set on the server, never accepted from the
	 *  browser: it is a URL the harness will fetch and execute a graph from. */
	studioOrigin: string;
}

/** The line that tells a task its references exist.
 *
 *  The agent's standing instructions describe what to do "when the task names
 *  reference images", and the first run with pictures attached proved how much
 *  work "names" was doing: the images uploaded, the artifact came back approved,
 *  the graph had its three image ports — and the task said nothing, so there was
 *  nothing for the agent to act on. The capability was wired end to end and
 *  silent at the last inch.
 *
 *  Empty for a clip with no references, which keeps the task text exactly as it
 *  has always been. */
function refClause(
	count: number,
	characterName?: string,
	locationName?: string,
	refUrls: string[] = []
): string {
	if (count < 1) return '';
	// NOT informational any more. This used to say "already wired into the
	// workflow, you do not need to pass them" — which was true of the asset
	// mechanism we believed in and false of the one that works. The images are
	// declared as required media input ports now, and the tool handler reads each
	// one straight from the agent's own arguments: a port that is missing comes
	// back as `missing required input: "ref_0"` and the render never starts.
	//
	// So the agent carries the URLs. That is not ideal — they are long presigned
	// links and an LLM is copying them — but there is no default value mechanism
	// for media ports, and the failure mode is loud rather than silent.
	//
	// The character is named when there is one, because it is the first reference
	// and the prompt addresses it as <Picture 1>: a reader comparing the prompt
	// against the task should be able to see which face that is.
	// Indented to the block scalar this lands inside. The name is free text and can
	// hold anything, which is safe here only because a `prompt: |` block takes it
	// verbatim — as long as every line carries the block's indentation. The first
	// version of this line did not, and the harness rejected the workspace with
	// "Implicit keys need to be on a single line".
	// Named in the order they are staged, because that order IS the numbering the
	// prompt uses. A clip with a location but no character has the location at
	// <Picture 1>, not <Picture 2> — the writer is told the same thing, and the
	// two must agree or the brief describes the wrong picture.
	const named: string[] = [];
	if (characterName) named.push(`the character ${characterName}`);
	if (locationName) named.push(`the location ${locationName}`);
	const who = named.length
		? named
				.map(
					(n, i) =>
						`        <Picture ${i + 1}> is ${indentBlock(n, 0)}.\n`
				)
				.join('')
		: '';
	// One line per port, each a single unbroken line: the value is a presigned URL
	// whose query string must survive verbatim, and a wrapped line is a corrupted
	// link. They are listed after the explanation rather than inside it so the
	// agent reads them as values to copy, not as prose.
	const ports = refUrls
		.map((url, i) => `        ref_${i} = ${url}\n`)
		.join('');

	return `
        This clip renders with ${count} reference image${count > 1 ? 's' : ''}. The workflow declares
        ${count > 1 ? 'them' : 'it'} as required input${count > 1 ? 's' : ''}, so you MUST pass ${count > 1 ? 'both' : 'it'} to the tool,
        each value copied exactly as written below — they are signed links and a
        single altered character makes them unusable.
${ports}${who}`;
}

export const DIRECT_MAX_CLIPS = 4;
const DIRECT_PROMPT_MAX = 20_000;

export function directWorkspaceId(spec: DirectSpec): string {
	return `${spec.slug}-direct@${WORKSPACE_VERSION}`;
}

/** Only the workflow the prompts are written for. krea2 is a text-to-image
 *  workflow and there is no image step here; leaving it in gives the agent a
 *  tool it could pick by mistake.
 *
 *  The url is a link to this app rather than a `name@branch` registry ref,
 *  because the adapter stack is decided per clip and a bundle in git cannot be.
 *  The studio generates the bundle when the harness asks for it — see
 *  routes/studio/api/wf. Everything else about the bundle, ports included,
 *  still comes from the copy in git; only the adapter list is written fresh.
 *
 *  `name` stays constant on purpose, so the tool the agent is told to call is
 *  called the same thing on every run. */
/** Two settings that came out of measuring where a clip's wait actually goes.
 *
 *  A 5-second clip took 4m57s end to end: 37s to open the workspace and start
 *  the task, 102s between the task starting and the GPU starting, 124s of
 *  render, and 34s to save and notice. The 102s is an LLM deciding to pass a
 *  prompt through unchanged, plus the compute endpoint being provisioned.
 *
 *  `lazy: false` moves the provisioning to workspace open, where it overlaps the
 *  agent's startup instead of queueing behind its first tool call. The guide
 *  recommends exactly this for a workflow expected to render soon after startup,
 *  which is the only thing a direct workspace exists to do.
 *
 *  The Operator runs on grok-fast rather than grok-4.5 for the same 102s. It
 *  makes no content judgement — the prompt arrives finished and its whole job is
 *  to hand it over unchanged — and our own note above measures the two at 8.3s
 *  against 29.6s on ordinary work.
 *
 *  The risk in that second change is worth stating: grok-fast has never been
 *  asked to relay explicit text, and the failure mode if it refuses is the quiet
 *  one — nothing written, task_complete called, the gate reporting no files, and
 *  a retry loop. If a run dies that way, this line is the first suspect and
 *  grok-4-5 is the revert. */
function directWorkflows(
	origin: string,
	picks: Pick[],
	baseAt: Record<string, number>,
	refNames: string[],
	slug: string
): string {
	// Only the picks. The pair every clip loads is added by the endpoint that
	// builds the bundle, and naming it here as well was not merely redundant: the
	// parser caps a selection at MAX_PICKS, so once that cap came down to two the
	// two base entries filled it and the actual choices were dropped off the end.
	// Every render between then and now ran on the base pair alone.
	// `base` when nothing was chosen, rather than an empty segment: the url would
	// otherwise collapse to /wf//workflow.yaml, which matches no route, and a clip
	// the writer found no adapter for would fail to render at all.
	// The base adapters travel too, carrying their strengths. They cannot be
	// mistaken for picks — the parser refuses base keys on that side — so this is
	// a number for each, never a slot.
	const base = BASE.map((l) => ({ key: l.key, strength: baseAt[l.key] ?? l.strength }));
	// `ref-<n>` rides in the same segment. It is not a pick and the parser that
	// reads picks ignores it, so it cannot take a slot from an adapter.
	// `run-<slug>` rather than a count: the generator serves this clip's
	// reference images from the same directory it serves the bundle from, so it
	// needs to know whose they are, not merely how many.
	const sel =
		[formatPicks([...base, ...picks]), refNames.length ? `run-${slug}` : '']
			.filter(Boolean)
			.join(',') || 'base';
	// No `assets:` here, and none in the bundle either.
	//
	// Both were tried, together and separately, and all three renders died on the
	// GPU looking for /ComfyUI/input/ref_1.png. The harness only honours `assets`
	// when the entry url ends in `.json`: the `.yaml` path rebuilds the spec as
	// { name, description, url } and drops the list, and the bundle's own key is
	// never read at any point. The reference images travel as media input ports
	// instead — declared by the bundle, supplied as presigned URLs at render time.
	return `  workflows:
    - name: minimaxh3_t2v_i2v_ref2v_advanced_film_making_foxydit
      url: ${origin}/studio/api/wf/${encodeURIComponent(sel)}/workflow.yaml
      lazy: false`;
}

/** Resolution is a parameter here rather than a constant, because the two
 *  scenes of the last run came back 480x864 and 720x480 — each worker had
 *  decided for itself. Fixing it in the profile is what stops that. */
/** The two numbers the render profile is built from, named so the render log
 *  records what actually ran rather than a second copy of it that can drift. */
export const DIRECT_STEPS = 8;
export const DIRECT_FPS = 48;

function directProfiles(spec: DirectSpec): string {
	// steps=8, chosen by watching the clips move.
	//
	// The cost is real and worth knowing before touching this: 8 renders in 174s
	// against 121s at 4, so every clip takes about 44% longer.
	//
	// Both were rendered from the same pinned seed, so the two clips are the same
	// room, the same woman and the same pose with only the sampling between them.
	// Compared as still frames, 4 looked the more photographic of the two — the
	// freckles survive, the pores hold, the flyaway hair stays separate, and 8
	// puts a sheen on the nose and cheekbone. Compared as moving clips, which is
	// what this tool actually produces, 8 was the better one. A still cannot show
	// how a clip holds together frame to frame, so the moving comparison is the
	// one that decides it.
	//
	// An earlier version of this note argued that 8 carries the turbo adapter past
	// the schedule it was distilled for, lightx2v_turbo_4step being a four-step
	// distillation. That was put too strongly. The workflow's own port notes place
	// 6-10 inside the adapter's range at strength 0.6-1.0, and ours sits at 0.7 —
	// so 8 is a documented setting that buys a different look for more time, not a
	// setting being abused.
	//
	// 6 is the middle if the render time starts to hurt, and is equally inside the
	// range. And the slider at 1.6 was tuned with 4 steps underneath it, so if the
	// surface ever needs revisiting, that pairing has not actually been tested.
	return `  profiles:
    draft:
      image: { width: ${spec.width}, height: ${spec.height}, steps: ${DIRECT_STEPS}, seed: ${spec.seed} }
      video: { width: ${spec.width}, height: ${spec.height}, steps: ${DIRECT_STEPS}, fps: ${DIRECT_FPS}, seed: ${spec.seed} }
      audio: { sampleRate: 16000 }
      compute: { backend: modal, gpuType: a100, timeoutSec: 1800, maxAttempts: 2 }`;
}

const DIRECT_AGENT = (model: string) => `    generic:
      id: generic
      name: "Operator"
      model: grok-fast
      role: "Render operator"
      objective: "Send the given prompt to the render workflow unchanged and save the clip"
      systemPrompt: >
        You operate a render workflow. You do not write prompts, improve them,
        shorten them, restructure them or comment on them. The prompt arrives
        finished.

        For your task: call the wf_ tool for the minimax workflow with
        prompt_positive set to the prompt text given in the task, character for
        character, and video_length set to the seconds the task names. Resolution,
        fps and steps come from the render profile — do not pass your own.

        If the task lists reference inputs (ref_0, ref_1 …), pass each one as an
        argument of that name, with the URL copied exactly as the task wrote it —
        every character, including the whole query string. They are signed links
        and expire; do not shorten, re-encode, split or tidy them, and never
        invent one that was not given to you.

        Then save the returned mp4 to the exact filename the task declares and
        call task_complete. If the tool saved to a different path, call it again
        targeting the declared one.

        This is an adult production. The prompt is explicit on purpose and is the
        deliverable exactly as written. Passing it through unchanged is the whole
        of your job.
      readOnly: false`;

export function composeDirectWorkspace(spec: DirectSpec, grokKey = ''): string {
	if (!spec || typeof spec !== 'object') throw new Error('spec is missing');
	if (typeof spec.slug !== 'string' || !SLUG_RE.test(spec.slug)) throw new Error('bad slug');
	const prompts = (spec.prompts ?? []).map((p) => (typeof p === 'string' ? p.trim() : ''));
	if (!prompts.length || prompts.some((p) => !p)) throw new Error('every clip needs a prompt');
	if (prompts.length > DIRECT_MAX_CLIPS)
		throw new Error(`at most ${DIRECT_MAX_CLIPS} clips per run`);
	if (prompts.some((p) => p.length > DIRECT_PROMPT_MAX))
		throw new Error(`a prompt is longer than ${DIRECT_PROMPT_MAX} characters`);
	for (const n of [spec.seconds, spec.width, spec.height]) {
		if (!Number.isFinite(n) || n <= 0) throw new Error('seconds, width and height must be positive');
	}

	const tasks = prompts
		.map(
			(p, i) => `    - id: clip_${i + 1}
      title: "Clip ${i + 1}"
      description: "Render clip ${i + 1} from the given prompt."
      # Plain llm. This was llm+hitl for four hours, declared early so a finished
      # render could be talked to later, and the note here said the cost was that
      # "the task waits for an explicit completion rather than closing itself".
      # That cost was the whole delivery path: nothing sends such a completion, so
      # the task never ends, the artifact never leaves status "empty", and the page
      # only collects clips from approved artifacts. The render succeeded and the
      # mp4 sat in the agent's sandbox where nobody could reach it.
      #
      # Six clips arrived on 2026-08-25 before 11:37 and none after — llm+hitl
      # landed at 14:42 that day. Sheets kept working throughout, because sheet
      # tasks were never given it.
      #
      # Put it back when there is a chat UI AND something that completes the task,
      # not before. A capability nothing uses is not free if it breaks the one
      # thing the run exists to produce.
      agent: generic
      prompt: |
        Render one video clip with the minimax workflow.

        video_length: ${spec.seconds}
        Save the result as clip${i + 1}.mp4
${refClause(spec.refImages ?? 0, spec.characterName, spec.locationName, spec.refUrls ?? [])}
        Pass the text below as prompt_positive, unchanged. Do not rewrite,
        shorten, expand, reorder or comment on it. It is already in the format
        the workflow expects.

        --- PROMPT BEGINS ---
${indentBlock(p, 8)}
        --- PROMPT ENDS ---
      artifacts:
        - id: clip_${i + 1}_out
          name: "Clip ${i + 1}"
          description: "Rendered clip ${i + 1}"
          files:
            - name: clip${i + 1}.mp4`
		)
		.join('\n\n');

	return `version: "1.0"
kind: Workspace
metadata:
  name: "${spec.slug}-direct"
  author: studio
  version: "${WORKSPACE_VERSION}"

spec:
  id: "${spec.slug}-direct"
  description: ${yamlDoubleQuoted(spec.title || 'Direct render')}
  # Required since the HITL release. We run no HITL tasks, but the field is
  # declared required at the spec level, so it is cheaper to name a model than
  # to find out at open-workspace.
  defaultTaskModel: grok-fast

  story:
    plot: |
      Direct render. The prompts are supplied by the operator and pass through
      unchanged.

  skills:
    - workflow-render-loop@mvp-lkg

${directWorkflows(spec.studioOrigin, spec.loras ?? [], spec.baseLoras ?? {}, spec.refNames ?? [], spec.slug)}

${directProfiles(spec)}

${modelsBlock(grokKey)}

  agents:
${DIRECT_AGENT(modelFor('generic'))}

  tasks:
${tasks}
`;
}

// ─── Sheets ───────────────────────────────────────────────────────────────────

/** A character or location sheet: one render, one image, six views of the same
 *  subject.
 *
 *  These get their own workspace rather than riding along with a clip, and the
 *  reason is not tidiness. A workspace carries exactly one render profile and
 *  every workflow in it shares that profile — but a sheet is a 1920x1080 still
 *  and a clip is a 576x1024 five-second video, so putting them together means
 *  one of the two renders at the other's size. They are also separate actions in
 *  the user's head: you make a character once and shoot with it for a week.
 */
export interface SheetSpec {
	slug: string;
	kind: 'character' | 'location';
	/** Which half of the work to do.
	 *
	 *  `anchor` renders only the KREA-2 still a character sheet is built from —
	 *  one picture, 17 GB of weights, about a third of the wait. `sheet` renders
	 *  the full six-view turnaround. They share the model, the sampler and the
	 *  seed, so an anchor is a faithful preview of the sheet rather than a
	 *  different picture of the same idea: find the face cheaply, then pay once.
	 *
	 *  Absent means `sheet`, so every existing caller keeps its behaviour. */
	stage?: 'anchor' | 'sheet';
	/** Where the harness should fetch the sheet bundle from — this app, at the
	 *  name Docker knows it by. Set on the server, never accepted from the
	 *  browser, for the same reason the clip bundle's origin is. */
	studioOrigin?: string;
	/** Plain English, passed to the workflow untouched. These two workflows take
	 *  a description rather than a structured prompt — their own port notes say
	 *  so — which is why no writer stands between you and them. */
	description: string;
	seed: number;
}

/** The registry workflow behind each kind, and the port that carries the
 *  description into it. Both come from the workflow's own published spec; the
 *  port names differ between the two, which is the only thing that varies. */
const SHEET_WORKFLOW = {
	character: {
		name: 'krea2_character_sheet',
		param: 'prompt_character',
		file: 'character_sheet.png',
		label: 'Character sheet'
	},
	// The anchor is a workflow of ours rather than one of the registry's, cut
	// from the sheet's own graph — see api/anchorwf. Its port name is the same,
	// which is not a coincidence: it is the same node.
	anchor: {
		name: 'krea2_character_anchor',
		param: 'prompt_character',
		file: 'anchor_image.png',
		label: 'Character preview'
	},
	anchorLocation: {
		name: 'krea2_location_anchor',
		param: 'prompt_location',
		file: 'anchor_image.png',
		label: 'Location preview'
	},
	location: {
		name: 'krea2_location_sheet',
		param: 'prompt_location',
		file: 'location_sheet.png',
		label: 'Location sheet'
	}
} as const;

export function sheetWorkflowName(kind: 'character' | 'location'): string {
	return SHEET_WORKFLOW[kind].name;
}

export function sheetFileName(kind: 'character' | 'location'): string {
	return SHEET_WORKFLOW[kind].file;
}

export function anchorFileName(): string {
	return SHEET_WORKFLOW.anchor.file;
}

/** Registry ref or our own copy of it.
 *
 *  The registry ref is one line and stays in step with upstream, which is why it
 *  was the first choice. It also lets the harness pick the cheapest card the
 *  workflow allows, and for these two that is an l40s — measured, not guessed:
 *  the first character sheet ran 09:54:22 to 09:57:17 inside `comfy-compute-l40s`
 *  while the render profile asked for a100 and was overruled. A workflow's own
 *  gpu_types is the only thing that decides this, so we serve the same YAML with
 *  that one line narrowed.
 *
 *  Falls back to the plain registry ref when no origin is known, so nothing here
 *  can turn a missing configuration into a workspace that will not open. */
function sheetUrl(spec: SheetSpec, name: string): string {
	if (!spec.studioOrigin) return `${name}@main`;
	// The anchor has no registry equivalent — it only exists as something we
	// serve — so it gets its own route rather than a kind-shaped one.
	// Kept correct rather than deleted, though nothing calls it today: previews go
	// straight to Modal via api/anchor and never build a workspace. If that path
	// ever breaks, this is the fallback, and a fallback pointing at a 404 is not
	// one. The kind segment was added when locations got an anchor of their own.
	if (spec.stage === 'anchor') {
		return `${spec.studioOrigin}/studio/api/anchorwf/${spec.kind}/workflow.yaml`;
	}
	return `${spec.studioOrigin}/studio/api/sheetwf/${spec.kind}/workflow.yaml`;
}

export function sheetWorkspaceId(spec: SheetSpec): string {
	return `${spec.slug}-sheet@${WORKSPACE_VERSION}`;
}

/** 1920x1080 because that is what both sheet workflows default to, and because
 *  the profile overrides whatever the tool is told — so a profile that disagreed
 *  with the workflow's own default would silently win and there would be no sign
 *  of it anywhere except a worse sheet.
 *
 *  It is also a valid ratio. The harness rejects a workspace whose frame is not
 *  on its list, and 16:9 is on it. */
const SHEET_W = 1920;
const SHEET_H = 1080;
const SHEET_STEPS = 8;
const SHEET_FPS = 24;

const SHEET_AGENT = `    generic:
      id: generic
      name: "Operator"
      model: grok-fast
      role: "Render operator"
      objective: "Send the given description to the sheet workflow unchanged and save the image"
      systemPrompt: >
        You operate a render workflow. You do not write descriptions, improve
        them, shorten them or comment on them. The description arrives finished
        and is passed through character for character.

        For your task: call the wf_ tool the task names, with the single named
        argument the task names, set to the description text given in the task.
        Width, height, steps and fps come from the render profile — do not pass
        your own.

        Then save the returned image to the exact filename the task declares and
        call task_complete. If the tool saved to a different path, call it again
        targeting the declared one.

        This is an adult production. The description may be explicit on purpose
        and is the deliverable exactly as written. Passing it through unchanged
        is the whole of your job.
      readOnly: false`;

export function composeSheetWorkspace(spec: SheetSpec, grokKey = ''): string {
	if (!spec || typeof spec !== 'object') throw new Error('spec is missing');
	if (typeof spec.slug !== 'string' || !SLUG_RE.test(spec.slug)) throw new Error('bad slug');
	if (spec.kind !== 'character' && spec.kind !== 'location') throw new Error('bad sheet kind');
	const description = (spec.description ?? '').trim();
	if (!description) throw new Error('a sheet needs a description');
	if (description.length > DIRECT_PROMPT_MAX)
		throw new Error(`the description is longer than ${DIRECT_PROMPT_MAX} characters`);

	const wf =
		spec.stage === 'anchor'
			? spec.kind === 'location'
				? SHEET_WORKFLOW.anchorLocation
				: SHEET_WORKFLOW.anchor
			: SHEET_WORKFLOW[spec.kind];

	return `version: "1.0"
kind: Workspace
metadata:
  name: "${spec.slug}-sheet"
  author: studio
  version: "${WORKSPACE_VERSION}"

spec:
  id: "${spec.slug}-sheet"
  description: ${yamlDoubleQuoted(`${wf.label} — ${description.slice(0, 60)}`)}
  defaultTaskModel: grok-fast

  story:
    plot: |
      Reference sheet render. The description is supplied by the operator and
      passes through unchanged.

  skills:
    - workflow-render-loop@mvp-lkg

  workflows:
    - name: ${wf.name}
      url: ${sheetUrl(spec, wf.name)}
      lazy: false

  profiles:
    draft:
      image: { width: ${SHEET_W}, height: ${SHEET_H}, steps: ${SHEET_STEPS}, seed: ${spec.seed} }
      video: { width: ${SHEET_W}, height: ${SHEET_H}, steps: ${SHEET_STEPS}, fps: ${SHEET_FPS}, seed: ${spec.seed} }
      audio: { sampleRate: 16000 }
      compute: { backend: modal, gpuType: a100, timeoutSec: 1800, maxAttempts: 2 }

${modelsBlock(grokKey)}

  agents:
${SHEET_AGENT}

  tasks:
    - id: sheet
      title: ${yamlDoubleQuoted(wf.label)}
      description: "Render the reference sheet from the given description."
      agent: generic
      prompt: |
        Render one reference sheet with the ${wf.name} workflow.

        Save the result as ${wf.file}

        Pass the text below as ${wf.param}, unchanged. Do not rewrite, shorten,
        expand, reorder or comment on it.

        --- DESCRIPTION BEGINS ---
${indentBlock(description, 8)}
        --- DESCRIPTION ENDS ---
      artifacts:
        - id: sheet_out
          name: ${yamlDoubleQuoted(wf.label)}
          description: "The rendered reference sheet"
          files:
            - name: ${wf.file}
`;
}

/* ── Continuation ────────────────────────────────────────────────────────────
 *
 *  A clip you already have, extended. The workflow takes the clip itself as a
 *  reference video alongside the character and the location it was shot with,
 *  and generates what happens next.
 *
 *  It renders ONLY the new stretch — there is no join inside the graph — so a
 *  long scene is a chain of clips that get glued at the end. That is why the
 *  bundle this points at is our own rewrite of Hannes's: his renders 848x480 at
 *  24 fps, and a piece at another size or rate cannot be glued to the clip it
 *  continues without re-encoding the lot.
 */
export interface ContinuationSpec {
	slug: string;
	title?: string;
	/** What you typed — kept for the record, not sent to the model. */
	request?: string;
	/** The finished brief the workflow receives. */
	prompt: string;
	seconds: number;
	width: number;
	height: number;
	seed: number;
	loras?: Pick[];
	baseLoras?: Record<string, number>;

	/** The clip being continued, as three ids the server can read bytes from. */
	priorWorkspace: string;
	priorArtifact: string;
	priorFile: string;

	/** The character and the location it was shot with. Both are required by the
	 *  workflow, and both are ids into the sheet store. */
	characterId?: string;
	locationId?: string;
	characterName?: string;
	locationName?: string;

	/** Presigned urls, set server-side once the three files are uploaded. Never
	 *  taken from the payload: they end up in the agent's prompt as links to
	 *  fetch, so the browser does not get a say in where they point. */
	priorClipUrl?: string;
	characterUrl?: string;
	locationUrl?: string;

	studioOrigin?: string;
}

export function continuationWorkspaceId(spec: ContinuationSpec): string {
	return `${spec.slug}-cont@${WORKSPACE_VERSION}`;
}

/** Steps and frame rate come from the clip being continued, not from a fresh
 *  choice: a continuation that samples differently is a different look. */
export const CONT_STEPS = DIRECT_STEPS;
export const CONT_FPS = DIRECT_FPS;

export function composeContinuationWorkspace(spec: ContinuationSpec, grokKey = ''): string {
	if (!spec || typeof spec !== 'object') throw new Error('spec is missing');
	if (typeof spec.slug !== 'string' || !SLUG_RE.test(spec.slug)) throw new Error('bad slug');
	const prompt = (spec.prompt ?? '').trim();
	if (!prompt) throw new Error('a continuation needs a prompt');
	if (prompt.length > DIRECT_PROMPT_MAX) {
		throw new Error(`the prompt is longer than ${DIRECT_PROMPT_MAX} characters`);
	}
	for (const [name, u] of [
		['the prior clip', spec.priorClipUrl],
		['the character', spec.characterUrl],
		['the location', spec.locationUrl]
	] as const) {
		// All three are required inputs of the workflow. A missing one comes back
		// as `missing required input` from the tool handler rather than a render,
		// but failing here says which and costs nothing.
		if (!u) throw new Error(`${name} has no url — it was not uploaded`);
	}
	for (const n of [spec.seconds, spec.width, spec.height]) {
		if (!Number.isFinite(n) || n <= 0) throw new Error('seconds, width and height must be positive');
	}

	const origin = spec.studioOrigin || 'http://host.docker.internal:5290';
	const base = BASE.map((l) => ({ key: l.key, strength: spec.baseLoras?.[l.key] ?? l.strength }));
	const sel = formatPicks([...base, ...(spec.loras ?? [])]) || 'base';

	return `version: "1.0"
kind: Workspace
metadata:
  name: "${spec.slug}-cont"
  author: studio
  version: "${WORKSPACE_VERSION}"

spec:
  id: "${spec.slug}-cont"
  description: ${yamlDoubleQuoted(spec.title || 'Continuation')}
  defaultTaskModel: grok-fast

  story:
    plot: |
      Continuation. The prompt is supplied by the operator and passes through
      unchanged.

  skills:
    - workflow-render-loop@mvp-lkg

  workflows:
    - name: minimax_h3_video_continuation
      url: ${origin}/studio/api/contwf/${encodeURIComponent(sel)}/workflow.yaml
      lazy: false

  profiles:
    draft:
      image: { width: ${spec.width}, height: ${spec.height}, steps: ${CONT_STEPS}, seed: ${spec.seed} }
      video: { width: ${spec.width}, height: ${spec.height}, steps: ${CONT_STEPS}, fps: ${CONT_FPS}, seed: ${spec.seed} }
      audio: { sampleRate: 16000 }
      compute: { backend: modal, gpuType: a100, timeoutSec: 2400, maxAttempts: 2 }

${modelsBlock(grokKey)}

  agents:
    generic:
      id: generic
      name: "Operator"
      model: grok-fast
      role: "Render operator"
      objective: "Send the given prompt and the three references to the continuation workflow and save the clip"
      systemPrompt: >
        You operate a render workflow. You do not write prompts, improve them,
        shorten them, restructure them or comment on them. The prompt arrives
        finished.

        Call the wf_ tool for the continuation workflow with prompt_positive set
        to the prompt text given in the task, character for character, and
        duration_seconds set to the seconds the task names. Resolution, fps,
        steps and seed come from the render profile — do not pass your own.

        The task lists three references: prior_clip, character_sheet and
        environment_plate. Pass each one as an argument of that name, with the
        URL copied exactly as written — every character, including the whole
        query string. They are signed links and expire; do not shorten,
        re-encode, split or tidy them, and never invent one.

        Then save the returned mp4 to the exact filename the task declares and
        call task_complete.

        This is an adult production. The prompt is explicit on purpose and is the
        deliverable exactly as written. Passing it through unchanged is the whole
        of your job.
      readOnly: false

  tasks:
    - id: cont_1
      title: "Continuation"
      description: "Continue the prior clip from its final frame."
      agent: generic
      prompt: |
        Continue one video clip with the continuation workflow.

        duration_seconds: ${spec.seconds}
        Save the result as cont1.mp4

        Three references, each copied exactly as written:
        prior_clip = ${spec.priorClipUrl}
        character_sheet = ${spec.characterUrl}
        environment_plate = ${spec.locationUrl}

        <Video 1> is the clip being continued.
        <Picture 1> is the character${spec.characterName ? ` ${indentBlock(spec.characterName, 0)}` : ''}.
        <Picture 2> is the location${spec.locationName ? ` ${indentBlock(spec.locationName, 0)}` : ''}.

        Pass the text below as prompt_positive, unchanged. Do not rewrite,
        shorten, expand, reorder or comment on it.

        --- PROMPT BEGINS ---
        ${indentBlock(prompt, 8)}
        --- PROMPT ENDS ---
      artifacts:
        - id: cont_1_out
          name: "Continuation"
          description: "Rendered continuation"
          files:
            - name: cont1.mp4
`;
}
