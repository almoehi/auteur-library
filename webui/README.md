# auteur web UI

A chat-first front end for the auteur harness. You describe a film in one
sentence, approve the plan it writes back, and it shoots.

It talks to a locally running harness over its HTTP API and imports nothing from
it — the two are separate processes that only share a port number.

```bash
cp .env.example .env       # then paste OLLAMA_API_KEY from ~/auteur/.env
pnpm install
pnpm dev                   # http://127.0.0.1:5174
```

Requires a harness already running (`~/auteur/run.sh`). The UI reaches it at
`host.docker.internal:19006`; override with `AUTEUR_HARNESS_URL` if yours is
elsewhere.

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
