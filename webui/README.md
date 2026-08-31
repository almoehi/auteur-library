# auteur web UI

A chat-first front end for the auteur harness. You describe a film in one
sentence, approve the plan it writes back, and it shoots.

It talks to a locally running harness over its HTTP API and imports nothing from
it — the two are separate processes that only share a port number.

```bash
cp .env.example .env       # then paste OLLAMA_API_KEY from ~/auteur/.env
pnpm install
pnpm dev --port 5290       # http://127.0.0.1:5290
```

Requires a harness already running (`~/auteur/run.sh`). The UI reaches it at
`host.docker.internal:19006`; override with `AUTEUR_HARNESS_URL` if yours is
elsewhere.

The port is not cosmetic. A render's workspace YAML tells the harness to fetch
its workflow bundle back from this server — the studio rewrites the LoRA stack
into the bundle per render, so the bundle only exists here — and the address it
writes defaults to `host.docker.internal:5290`. On any other port every render
fails at the fetch. Serve on 5290, or set `AUTEUR_STUDIO_URL` to wherever you
actually serve.

## Two things that are not in this repo

Checking the branch out is not enough. Two settings live on the machine, and
without either one the app runs and quietly produces worse clips than the code
is written for.

**ComfyUI 0.34.0 on the Modal endpoints.** The seam anchor packs a keyframe
latent at frame 0 of a continuation, and on 0.32.0 the model places it at the
text origin rather than after the reference span — so it lands displaced by the
whole reference block. The anchor still grips, at the wrong position: measured,
the join sits at 13x the clip's own frame-to-frame change instead of 0.9x, which
is what the visible cut at a continuation looked like for months. Upstream fixed
it in `e01fb4c56b`, first released in v0.34.0.

```bash
rm -f ~/.local/share/video-harness/.modal-deploy-sha    # it stores the hash of
                                                        # empty input, so the
                                                        # deploy silently skips
cd ~/auteur && docker run --rm <credentials> almoehi/auteur:latest \
  deploy-modal.sh --cuda 13 --comfy 0.34.0 --upgrade
echo 'COMFY_VERSION=0.34.0' >> ~/auteur/.env             # the harness filters
                                                        # endpoints by name:
                                                        # comfy-compute-{gpu}-cu13-{vSlug}
```

The container reads `.env` at `docker run`, not at `docker restart`, so it has
to be recreated for the variable to take. Rolling back is one line — set it to
`0.32.0` and recreate; the old endpoints stay deployed under their own names.

**The harness image is pinned.** `run.sh` defaults to `almoehi/auteur:latest`,
and the build from 2026-08-30 renders and uploads on the GPU but never collects
the artifact: the task sits at `running`, the event log shows only `dispatch`,
and the cost stops climbing while nothing arrives. Reason not established.

```bash
docker tag <the working image id> almoehi/auteur:known-good
cd ~/auteur && TAG=known-good ./run.sh --local
```

One more thing worth knowing before an image change: golem's oplog format is not
compatible across versions, so a new image hits a crash loop on the workspaces
the old one wrote — `failed to deserialize oplog chunk`, endlessly. The fix is
to move `~/auteur/data/kv-store` aside; nothing of yours is in there. Clips,
sheets and the render log live in `~/auteur/studio-library` and survive.

## Setting up a second machine

Three things have to match, and three cannot.

**Must match — otherwise you get different clips from the same brief:**

| | value | why |
| --- | --- | --- |
| branch | `dszabo` | the writer rules and the anchor live here |
| harness image | `almoehi/auteur@sha256:701a36ff…` | the newer build renders on the GPU and never collects the artifact |
| `COMFY_VERSION` | `0.34.0` | on 0.32.0 the seam anchor lands at the wrong frame |

**Cannot match, and should not:** `MODAL_WORKSPACE`, the Modal token pair, and
the AWS keys are per account. Each machine deploys its own compute endpoints and
writes to its own bucket. What has to be the same is the *version* of the
endpoints, not the account they live in.

The image is pinned by digest rather than by tag because `almoehi/auteur:latest`
moved on 2026-08-30 and a tag pointing at the old build exists only on the
machine that made it — `docker pull almoehi/auteur:known-good` finds nothing.

```bash
docker pull almoehi/auteur@sha256:701a36ff5e843b9bd20471e0faeb44dd0eeb9f79d10599ac3b56af7889032e6a
docker tag  almoehi/auteur@sha256:701a36ff5e843b9bd20471e0faeb44dd0eeb9f79d10599ac3b56af7889032e6a \
            almoehi/auteur:known-good

rm -f ~/.local/share/video-harness/.modal-deploy-sha   # stores the hash of empty
                                                       # input; without this the
                                                       # deploy skips in silence
# deploy 0.34.0 to YOUR OWN Modal account, then:
echo 'COMFY_VERSION=0.34.0' >> ~/auteur/.env

cd ~/auteur && TAG=known-good ./run.sh --local         # --local: the tag is not
                                                       # in the registry, only
                                                       # the digest is
```

Then run `webui/scripts/parity.sh` on both machines and diff the two outputs.
Everything above the env block should be identical; in the env block only
`MODAL_WORKSPACE` and the key lengths are allowed to differ. It prints no secret
values, so the output is safe to paste to each other.

## The seam anchor

`SEAM_ANCHOR` in `compose.ts` switches it. Off, the continuation bundle is byte
for byte what it was before the anchor existed; on, `H3KeyframeInject` sits
between the reference node and the guider, taking its frame off the loader the
prior clip is already on. It is on, and it needs the ComfyUI above.

## The three surfaces

| route           | what it is                                                     |
| --------------- | -------------------------------------------------------------- |
| `/studio`       | the chat. Idea in, approvals, then the film                     |
| `/studio/admin` | the prompts and model assignments, editable                     |
| `/ops`          | raw operator view — task states, event log, artifacts           |

## Why a production runs as two workspaces

A workspace cannot be paused, and its YAML is immutable once opened. That rules
out the obvious design, where one workspace runs the whole pipeline and stops
for a human at the interesting moments.

So a production is split in two. The first workspace does planning only —
screenplay, art direction, visual bible, casting. It is LLM-only, takes about
four minutes and costs no GPU time. When it finishes the studio shows each
document and waits.

Nothing is rendered until you approve. Then a second workspace opens with the
approved documents inlined into its YAML, and that one shoots.

The cost of this is that a revision is not free — a changed document means
re-opening a planning workspace under a fresh slug, because an id can only be
opened once. The benefit is that a person sees a screenplay before a GPU bill
exists, which is worth more.

## Tuning

`/studio/admin` exposes the fixed instructions the crew works from — eight of
them, ordered by how much they move the finished film rather than by pipeline
position. The prompt writer is first because it decides what a shot looks like.

Each entry says what it changes and which model runs it. Edits are stored as
deltas in `~/auteur/studio-tuning/overrides.json`, with the previous forty
versions kept beside it; the shipped defaults live in `src/routes/studio/tunables.ts`
and are never written to that file, so an empty file means everything is stock.

Changes apply to the **next** production. A running one composed its YAML at
launch and cannot be edited — the harness's rule, not ours.

## Notes for anyone working on this

**No authentication, on purpose.** Every route is open, the file route will
stream any artifact from any workspace, and the tuning route writes into your
home directory. Vite is bound to `127.0.0.1` for that reason. Do not put this
behind a public hostname.

**The harness sends no CORS headers.** A cross-origin `<video src>` still plays,
but `fetch()` of a text artifact is blocked, so everything goes through the
same-origin routes at `/api/harness` and `/api/file`.

**`open-workspace` is not in the proxy allowlist and should stay out.** Opening
is the one irreversible call — an id opens once, reopening is a silent no-op,
and a run costs real GPU time. It lives at `/studio/api/launch`, which composes
the YAML itself and is therefore the only route that ever holds one.

**Renders need a GPU the workflow bundle accepts.** A bundle declares its own
`gpu_types`, and those override the profile — minimax wants a100 or better and
will 404 on an l40s rather than say so.

## Layout

```
src/routes/
  studio/            the chat, the composer, the approval gates
    compose.ts       Brief -> workspace YAML (both stages)
    tunables.ts      the prompt + model registry
    render-doc.ts    model output -> structured blocks, never raw HTML
    api/plan         one sentence -> Brief
    api/launch       Brief -> workspace, opened
    api/tuning       read/write the overrides
  api/harness        POST proxy, allowlisted ops
  api/file           artifact bytes, same-origin
  ops/               the operator dashboard
```
