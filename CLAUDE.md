# auteur-library

Two processes, one repo. The **harness** is a Docker container (`~/auteur`,
started by `./run.sh` — not in git, it arrives out of band). The **webui** is a
SvelteKit app in `webui/`, run with `pnpm dev` on `http://127.0.0.1:5174`. They
share nothing but a port number. `webui/README.md` explains the architecture and
why a production runs as two workspaces — read it before changing the composer.

## The one thing that will cost you a day if you don't know it

**The harness fetches skills and workflows from GitHub, not from disk.** Its
registry holds `skillRepos`/`workflowRepos = main@almoehi/auteur-library`, and
the `name@ref` suffix in a workspace YAML — `krea2_base_realism@mvp-lkg`,
`minimaxh3_..._foxydit@dszabo` — is a **git ref in this repo**.

Consequences:

- Editing `skills/` or `workflows/` locally changes **nothing** until you commit
  and push to a branch, and point the ref at that branch. There is no local
  override. (One exception: `/studio/api/shotprompt` reads
  `prompt-writer-minimaxh3/SKILL.md` off disk from `../skills/`.)
- The refs are written in `webui/src/routes/studio/compose.ts` — `SKILLS_BLOCK`
  and `WORKFLOWS_BLOCK` near the top, and again in the sheet/continuation
  composers further down. **The skills all point at `@mvp-lkg`**, a tag from
  2026-08-15. Change a skill without changing that ref and the old version keeps
  running, silently.
- A branch ref is a moving target: when someone pushes to `dszabo`, the next
  workspace opened against `@dszabo` gets the new version. Pushing a
  half-finished workflow changes what your colleagues render.
- `webui/` is the opposite: never fetched, always local. Push it whenever.

Some workflows are pulled straight from `raw.githubusercontent.com/.../main/workflows`
at request time (sheet, continuation and anchor routes) — those always track
Hannes's `main`, regardless of which branch you are on.

## Branches

| branch | owner | what lives there |
| --- | --- | --- |
| `main` | Hannes (`almoehi`) | `skills/` + `workflows/` only — no webui |
| `dszabo` | Dezső (`dszab8`) | the webui, plus his own workflow edits |
| `luca` | Luca (`Luciaferroo`) | branched off `dszabo`, own render channel |

As of 2026-08-30 `dszabo` is 231 commits ahead of `main` and **8 behind** it, and
`main` has never received the webui. Merging `main` into `dszabo` conflicts in
exactly two files — `workflow.json` and `workflow.yaml` under
`minimaxh3_t2v_i2v_ref2v_advanced_film_making_foxydit` — because both Hannes and
Dezső edited that workflow. Only they can say which side is right. Do not
resolve it unilaterally.

Use your own branch as a render channel: point a ref at `@<yourbranch>` to test a
workflow change without touching what anyone else renders.

## Running it

```bash
cp webui/.env.example webui/.env    # then paste GROK_API_KEY
pnpm --dir webui install
pnpm --dir webui dev
```

- **`GROK_API_KEY` is required** — every LLM call has gone to xAI since
  2026-08-25. Without it `plan`, `shotprompt`, `angles` and `launch` all refuse.
  `OLLAMA_API_KEY` is dead; nothing reads it.
- `MODAL_WORKSPACE`, the S3 keys and the rest are read from `~/auteur/.env`
  directly. Do not duplicate them into `webui/.env`.
- The harness answers on `host.docker.internal:19006`, **never on localhost** —
  its router matches on the Host header, and `run.sh` adds the `/etc/hosts`
  entry. The endpoint is `/openapi.yaml`, not `.json`.
- `webui/pnpm-workspace.yaml` ships a placeholder (`esbuild: set this to true or
  false`) that has to be `true` locally or vite will not start. It has never been
  fixed upstream, so it lives as an uncommitted local edit.

## Care

- **`open-workspace` is the one irreversible call.** An id opens once, reopening
  is a silent no-op, and a run costs real GPU time. It is deliberately absent
  from the `/api/harness` proxy allowlist and must stay absent.
- **One production at a time.** Several in parallel corrupted the golem oplog
  once (`Unexpected oplog entry`), and a `docker restart harness` does not fix it
  — the oplog is persistent in `~/auteur/data`, so only deleting `data/` helps,
  which takes every workspace with it.
- A "stalled" task in the studio is the label for `failed`, not a timeout. The
  reason only shows in the event log: `get-event-log` via `/api/harness`, and
  never drop the `@1.0` from a workspace id — the harness answers a bare id with
  a WASM panic that sends you the wrong way.
