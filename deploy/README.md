# Hosting the studio at ratemyd.app/studio

The studio runs as its own small service; the harness is Hannes's Modal
deployment, reached over HTTPS; Vercel rewrites `www.ratemyd.app/studio/*` to
the studio. Nothing here runs a harness, spawns containers, or touches a GPU —
that was the laptop's job, and it is Modal's now.

```
browser ──> www.ratemyd.app/studio/*   (Vercel rewrite, ratemyd repo)
        ──> https://studio-origin.ratemyd.app   Caddy: TLS + one shared password
        ──> 127.0.0.1:5290                      studio (adapter-node)
              │  submit / status / proxy  ──>  Hannes's harness on Modal
              │                                  └── sandbox ── GPU (H100)
              └── the sandbox fetches each render's workflow bundle back
                  from the studio's public origin
```

## The box

- Ubuntu 24.04, **4 GB RAM, 2 vCPU, 40 GB disk** is plenty: the studio is a
  Node process and a 918 MB image; clips accumulate at ~4 MB each.
- Docker Engine + the compose plugin. `ufw` with only 22, 80, 443 open. Nothing
  else listens on a public interface — the studio binds loopback.
- Ports 80 and 443 reachable from the internet (Let's Encrypt).

## DNS (Cloudflare)

One `A` record: `studio-origin.ratemyd.app` → the box's IP, **DNS only** (grey
cloud). Caddy fetches its own certificate; a proxied (orange) record would put
Cloudflare's TLS in front and needs a different Caddy setup.

## Files on the box, in this directory

| file | what |
|---|---|
| `auteur.env` | copy of the laptop's `~/auteur/.env`. The studio reads `GROK_API_KEY` from it, and `AWS_ACCESS_KEY` / `AWS_SECRET_KEY` / `AWS_REGION` / `S3_BUCKET` for the reference uploads the sandbox fetches. The Modal keys in it are the *account's* and are not used here. |
| `.env` | from `.env.example`: origin host, public origin, the Modal **proxy** token pair, basic-auth user + hash |
| `studio-library/`, `studio-tuning/` | the studio's disk: clips, refs, sheets, render log, and `jobs.json` — the book that maps each workspace to its Modal job |

`chmod 600 auteur.env .env`. Neither is ever committed — `deploy/.gitignore`
covers them.

## Bring-up

```bash
docker run --rm caddy:2 caddy hash-password --plaintext 'choose a password'   # → BASIC_AUTH_HASH
docker compose pull caddy
docker compose build studio
docker compose up -d
docker compose logs -f studio      # "Listening on http://127.0.0.1:5290"
```

Checks, from the box:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5290/studio                 # 200
curl -s -o /dev/null -w '%{http_code}\n' https://studio-origin.ratemyd.app/studio    # 401 without the password
curl -s https://studio-origin.ratemyd.app/studio/api/wf/base/workflow.yaml | grep '^url:'   # url: workflow.json — relative
```

Then, in the ratemyd repo, the `rewrites` block in `vercel.json` (branch
`dszab8/studio-path-rewrite`) points `/studio`, `/studio/*` and `/studio-app/*`
at the origin. Deploy that and `www.ratemyd.app/studio` is the studio.

## How a render travels

1. The studio composes the workspace YAML and POSTs it whole to Modal
   (`submit`). It gets a job id back and writes it into `jobs.json`.
2. It polls `status` until the job reports a sandbox id — under 40 s cold,
   under 10 s when a sandbox is already warm; one sandbox serves many jobs.
3. From then on every call the studio used to make to the local harness goes
   to `{proxy}/{sandboxId}/workspaces/{id}/...` with the two auth headers.
   Same paths, same bodies. The page's poll-state, the event log, the Stop
   button's teardown, the clip fetch — all pass through.
4. Inside the sandbox the workspace opens, the workflow agent fetches the
   render's bundle from `STUDIO_ORIGIN/studio/api/...` (relative `url:` inside
   it — the absolute form 404s on this harness), and dispatches the GPU.
5. When the run ends the result names every artifact file by a presigned url.
   If the proxy no longer answers for that workspace, the studio serves clips
   from those urls and rebuilds the page's poll-state from the result, so a
   finished run still reads as finished.

## Verified through Vercel's rewrite proxy (2026-09-04, PR #1148 preview)

Both questions the first deploy was meant to answer were answered early, on a
preview whose rewrite pointed at a tunnel in front of the studio:

- **Precedence.** `/studio` returned the studio's HTML (title `studio · auteur`,
  assets under `/studio-app/`, none of ratemyd's `/_app/`); the rewrite
  outranks the SvelteKit catch-all.
- **Streaming.** The confirmation layer's reply arrived in 40 chunks, first at
  0.8 s, last at 2.0 s — the proxy streams rather than buffers.
- **Video.** An 8 MB clip came through whole in 1.9 s; a `Range: bytes=0-1023`
  request was answered 206 with a correct `content-range`, so `<video>`
  scrubbing (and iOS Safari, which insists on ranges) works.

So the path-rewrite design stands; the subdomain fallback is not needed.

## What this deliberately is not

No accounts, no token charge, no upload moderation — one shared password, one
operator's worth of state. It is the studio, hosted, on Hannes's harness, so the
first users can be watched. The account, payment and moderation layers are the
next step and are documented in the ratemyd repo (`photo_animation` is the
pattern to copy). The GPU bill lands in Hannes's Modal workspace until that is
settled.
