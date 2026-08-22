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
	// those win. It stays because the profile schema wants a value.
	return `  profiles:
    draft:
      image: { width: 720, height: 480, steps: 4, seed: ${seed} }
      video: { width: 720, height: 480, steps: 4, fps: 30, seed: ${seed} }
      audio: { sampleRate: 16000 }
      compute: { backend: modal, gpuType: l40s, timeoutSec: 1800, maxAttempts: 2 }`;
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
        - One-sentence action summary capturing the narrative and emotional beat
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
${indentBlock(tuned.write_art_direction, 8)}
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
