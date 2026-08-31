# Working on the auteur studio

What a session needs to know before it changes anything here. It is not a
history — where a thing was learned is in `git log`. This is what is true now,
and what has already been tried and did not work.

The studio is `webui/`: a SvelteKit app that composes workspace YAML, serves
rewritten workflow bundles, and talks to a locally running harness over HTTP.
`workflows/` and `skills/` are the library the harness resolves from.

## Two files govern clip quality, and a dozen fixes have landed in both

`webui/src/routes/studio/loras.ts` — the adapter catalogue, and the text the
writer reads about it.
`webui/src/routes/studio/tunables.ts` — the writers' instructions.

Every one of the rules in them was written because a render came back wrong.
Read the surrounding prose before rewriting a section: the risk is silently
undoing something a render already proved, and nothing will tell you.

The third file is `webui/src/routes/studio/promptcheck.ts` — structural faults
found in the brief before a GPU is paid for. It knows nothing about the
catalogue on purpose; callers pass what it needs.

## Settled by measurement

**Every person in the shot gets a `<Subject N>`, picture or not.** The rule used
to tie subjects to reference pictures, so a person without one had no way to
become a subject and stayed in prose. 38 of 106 briefs did this, and the renders
came back with the man facing backwards, barely moving, or absent.

**A change of state is not a cut.** The MiniMax H3 skill lists "state" as a
reason to cut and `tunables.ts` says a cut is a camera change; the skill is named
as the authority, so a last beat of motion stopping was rendered as an edit — the
framing jumped, a body left the picture, and the audio fell away in a tenth of a
second. The writer now overrules that line by name.

**A beat that stops or reverses motion has to write the deceleration, with a
span.** A state gives the model a place and no path to it, so it arrives in one
frame.

**A rate on its own buys a bounce.** Naming "two strokes a second" and nothing
else moves the whole body on that tempo — head, shoulders and chest travelling as
one block. A stroke needs three things: which part travels and what stays braced,
the shape (the withdrawal is the slow half), and contact at the end of each.

**An act adapter is weights, not a label.** It keeps producing what it was
trained on whether the description asks or not. A brief for "he pulls out and
comes on her stomach" came back with six strokes a second of thrusting because
the catalogue demanded exactly one act and the scene was sex. Aftermath, a
withdrawal, a cumshot, dialogue, standing up: none of those is an act, and the
base adapters carry them. At most one act, at most one detail — both capped in
code now, because stacking detailers has broken renders twice.

**Some adapters own the camera.** `miss` (POV missionary) was trained on one
viewpoint and reinstates it whatever the brief says. That single fact produced
two separate complaints — the partner missing from frame, and the woman's neck
and torso stretched by the foreshortening that viewpoint forces. The viewpoint is
now a `camera` field on the catalogue entry, printed in the writer's own list. A
new viewpoint-locked adapter needs the field filled in and nothing else.

**The seam anchor.** `SEAM_ANCHOR = true` in `compose.ts`. An `H3KeyframeInject`
node between `MiniMaxH3ReferenceToVideo` (169) and `BasicGuider` (143) packs the
prior clip's final frame as a latent at frame 0, so a continuation resumes from
it rather than near it. The join went from 13.5x the clip's own frame-to-frame
change to 0.63–0.97x, where a genuinely continuous cut measures 0.9x. The frame
comes off the prior clip's loader (`H3LastFrame` on node 177), not off
`ref_picture_3` — that port is optional, the operator agent drops it sometimes,
and when it did the render died on a dangling input.

**Keyframes and references coexist.** They travel on different conditioning keys
(`minimax_keyframes` / `minimax_refs`) as separate token segments. The node ports
suggest the opposite — the node that takes a first frame takes no references and
vice versa — and that trap cost a day. The anchor does not travel on a port.

**The prior clip's soundtrack carries the voices.** `VHS_LoadVideoFFmpeg` returns
audio on slot 2 and nothing read it, so voice identity rested on a sentence the
writer copied forward. Same source clip: 216 Hz, and two continuations written
from that description came back at 352 and 386 Hz. With the audio reference, 262
Hz and the spread down from 129 to 41. `H3ReferenceAudio` is mandatory in that
chain — a mono reference crashes the sampler.

**steps=8, not 4.** Same pinned seed both ways. Stills favoured 4; the moving
clips favoured 8, and moving is what ships.

**One primary change per beat, alternating between people.** A couple
masturbating side by side came back with the man frozen; his own timestamped beat
fixed it.

**Limbs across the frame, not into the lens.** A knee raised toward the camera
came back with the leg missing below it.

## How to measure, and how measurement lies here

**Run-to-run variance is larger than most effects.** The same configuration
rendered twice scored 11.4 and 21.6 on the seam metric. A single A/B decides
nothing. The seed does not pin the output either — byte-identical requests
produce unrelated videos.

**Do not trust a metric that the intervention writes directly.** A first seam
metric compared the continuation's frame 0 to the prior clip's last frame — and
the anchor writes frame 0. Pasting one copied frame onto the front of the worst
clip in the set scored better than the real fix. Use the frame-by-frame delta
profile instead (`scratchpad/deltaprofile.py` in a session's scratch): the paste
shows up as a duplicate followed by a spike two frames later.

**The ~62 ms autocorrelation peak is an artifact.** It sits at +0.78 to +0.89 in
every clip including the good ones — it is the 24 fps grid under the 48 fps
output. Read only the 150–330 ms and 350–670 ms bands.

**Timing comes from the harness event log**, dispatch to artifact-received. The
studio's own render log adds the browser's poll lag, typically 20-30s.

**Cost and duration follow endpoint warmth, not your change.** Six identical runs
climbed 220s to 460s in launch order. Do not read a cost difference as a result.

## Operations

**The harness image is pinned by digest.** `almoehi/auteur:latest` moved on
2026-08-30 to a build where the GPU renders and uploads but the harness never
collects the artifact — the task sits at `running` forever. Run
`almoehi/auteur@sha256:701a36ff5e843b9bd20471e0faeb44dd0eeb9f79d10599ac3b56af7889032e6a`,
tagged locally and started with `TAG=known-good ./run.sh --local`.

**`COMFY_VERSION=0.34.0` in `~/auteur/.env`.** The harness filters compute
endpoints by name (`comfy-compute-{gpu}-cu{N}-{version}`), so this is what
chooses them. On 0.32.0 the seam anchor lands at the wrong frame: that release
places a frame-0 anchor at the text origin while the target timeline starts after
the reference span. Fixed upstream in `e01fb4c56b`, first shipped in v0.34.0.
Not in 0.33.x — that line is a hotfix branch off 0.33.0 that never took the
commit, so a higher number is not enough.

**Serve the studio on 5290.** A render's workspace YAML tells the harness to
fetch the workflow bundle back from this server, because the studio rewrites the
LoRA stack into the bundle per render and it exists nowhere else. The address
defaults to `host.docker.internal:5290`; override with `AUTEUR_STUDIO_URL`. On
any other port every render fails at the fetch, silently.

**`.modal-deploy-sha` hashes empty input.** It contains sha256 of the empty
string, so it matches on every start and the Modal endpoints are never
redeployed. Delete the file before any deploy or nothing happens and nothing says
so.

**`docker restart` does not pick up `.env` changes.** `--env-file` is read when
the container is created. `docker rm -f harness` and run again.

**When the harness wedges on `NoActiveShards`** — "starting…" forever, then
`fetch failed` — the container is up but the worker executor is not answering.
`docker exec harness supervisorctl restart golem` recovers it in about ten
seconds without data loss. Check `docker logs harness --since 30s | grep -c
NoActiveShards`; anything but 0 means still wedged.

**Golem's oplog format is not compatible across harness versions.** Changing the
image sends it into a crash loop reading the existing store. Move
`~/auteur/data/kv-store` aside — the clips and sheets live in
`~/auteur/studio-library` and survive; what is lost is the ability to poll
finished workspaces.

**The workspace YAML carries model API keys in plaintext.** There is no env
substitution in that format.

**A workspace is immutable once opened.** Changing its YAML needs a
`metadata.version` bump, which opens a new empty workspace.

**Civitai versions must be referenced by their first `.safetensors`.** The
harness rewrites the fileId and fetches the first file regardless — it surfaces
as a 403 on a file nobody asked for, or a sha mismatch after the wrong bytes
arrive. Model downloads run on render-class GPUs, so each retry costs real time.

## Dead ends — do not retry

**No adapter fixes motion quality.** There is no motion-realism or physics
adapter in the catalogue, and stacking more has failed twice: four detailers left
the penetration anatomy incoherent, and the cock detailer alone wrecked a POV
missionary shot. Motion has to come from the prompt.

**Raising `mystic` from 0.6 to 0.9 is not an anatomy fix.** Measured: it
overrules the character sheet — different hair, fuller build.

**RIFE is not what makes motion look rubbery.** Interpolants sit 0.96–0.98 of the
way to the midpoint, none snapped to a neighbour, sharpness 94–98% of native.

**`prior_clip_start_time` trimmed to the last two seconds changes nothing.**
Built, measured across six runs, reverted.

**No doggy act adapter exists for MiniMax H3** — the position adapters that exist
are i2v-only and this path is t2v. **No squirt adapter exists at all**; the
cumshot adapter pointed at a female squirt produces a dribble.

**A second copy of the character sheet does not counteract chain drift.** 44.5%
against 43.9%, where the sheet itself is 29.6%.

**Full-URL workflow bundles do not load on the hosted harness** as of
2026-08-31 — not with `lazy: false`, not from a CDN serving correct content
types. Only the `name@ref` library form works. The failure surfaces as
"workspace is not open" from the status poll, which points at the wrong thing.
