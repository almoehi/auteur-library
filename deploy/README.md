# Hosting the studio at ratemyd.app/studio

One Linux box runs three containers — the harness, the studio, and Caddy — and
Vercel rewrites `www.ratemyd.app/studio/*` to it. The GPU work was already on
Modal; this moves the two pieces that were still on a laptop.

```
browser ──> www.ratemyd.app/studio/*  (Vercel rewrite)
        ──> https://studio-origin.ratemyd.app   Caddy: TLS + basic auth
        ──> 127.0.0.1:5290                      studio (adapter-node, host network)
        ──> host.docker.internal:19006          harness (Docker, loopback ports)
                └── sandboxes ── Modal (H100)   the GPU, unchanged
```

## The box

- Ubuntu 24.04, **8 GB RAM, 4 vCPU, 80 GB disk**. The harness image is 8 GB,
  its state grows to a few GB, and clips accumulate at ~4 MB each.
- Docker Engine + the compose plugin. `ufw` with only 22, 80, 443 open — see
  below for the one extra rule.
- Ports 80 and 443 reachable from the internet (Let's Encrypt).

## DNS (Cloudflare)

One `A` record: `studio-origin.ratemyd.app` → the box's IP, **DNS only** (grey
cloud). Caddy fetches its own certificate; a proxied (orange) record would put
Cloudflare's TLS in front and needs a different Caddy setup.

## Files on the box, in this directory

| file | what |
|---|---|
| `auteur.env` | copy of the laptop's `~/auteur/.env` — the harness AND the studio read it. Add `MODAL_TOKEN_ID=` / `MODAL_TOKEN_SECRET=` with the same values as `MODAL_API_KEY` / `MODAL_API_SECRET` (run.sh does this mapping; compose does not). Must contain `COMFY_VERSION=0.34.0`. |
| `.env` | from `.env.example`: origin host, public origin, basic-auth user + hash |
| `data/` | harness state (fresh — do not copy the laptop's kv-store, it holds the xAI key in plaintext and the machine-specific scheduler) |
| `workflows/` | empty, the harness expects the mount |
| `studio-library/`, `studio-tuning/` | the studio's disk: clips, refs, sheets, render log |

`chmod 600 auteur.env .env`. Neither is ever committed — `deploy/.gitignore`
covers them.

## Bring-up

```bash
# 1. the name the harness insists on, resolving to the box itself
grep -q host.docker.internal /etc/hosts || echo "127.0.0.1 host.docker.internal" | sudo tee -a /etc/hosts

# 2. containers on the docker bridge must reach the studio on the host at :5290;
#    ufw's default deny would block that hop. Nothing else on 5290 is opened.
sudo ufw allow in on docker0 to any port 5290 proto tcp

# 3. the basic-auth hash for .env
docker run --rm caddy:2 caddy hash-password --plaintext 'choose a password'

# 4. up
docker compose pull harness caddy
docker compose build studio
docker compose up -d
docker compose logs -f harness      # wait for the router to settle (~30 s)
```

Checks, from the box:

```bash
curl -s -H 'Host: host.docker.internal:19006' http://127.0.0.1:19006/openapi.yaml | head -3   # harness answers
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5290/studio                          # 200
curl -s -o /dev/null -w '%{http_code}\n' https://studio-origin.ratemyd.app/studio             # 401 without the password
```

Then, in the ratemyd repo, the `rewrites` block in `vercel.json` (branch
`dszab8/studio-path-rewrite`) points `/studio`, `/studio/*` and `/studio-app/*`
at the origin. Deploy that and `www.ratemyd.app/studio` is the studio.

## Two things to verify on the first deploy, not assume

1. **Vercel's rewrite proxy and the stream.** The confirmation layer streams
   its reply; `/studio/api/file` streams clips. Check on a PR preview that the
   first character arrives in about a second and a clip plays. If the proxy
   buffers, serve the origin as `studio.ratemyd.app` directly instead and turn
   the rewrite into a redirect — the same containers, `STUDIO_ORIGIN` changed.
2. **Rewrite precedence.** ratemyd has no `/studio` route, so the rewrite
   should win over the SvelteKit catch-all. Confirm `www.ratemyd.app/studio`
   returns the studio's HTML and not ratemyd's 404 page.

## What this deliberately is not

No accounts, no token charge, no upload moderation — one shared password, one
operator's worth of state, one harness. It is the laptop setup, hosted, so the
first users can be watched. The account, payment and moderation layers are the
next step and are documented in the ratemyd repo (`photo_animation` is the
pattern to copy).
