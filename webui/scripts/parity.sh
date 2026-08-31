#!/usr/bin/env bash
# Print a fingerprint of an auteur setup. Two machines run it, you diff the
# output, and what differs is what to fix.
#
# Prints no secret values. Credentials appear as a name and a length, so a
# missing key or an empty one shows up without the key itself leaving the
# machine.
#
# Written because comparing setups by conversation does not work: the first
# attempt at this compared `almoehi/auteur:latest` rather than the image the
# container was actually started from, and those were two different builds.
set -uo pipefail
AUTEUR="${AUTEUR_DIR:-$HOME/auteur}"
say() { printf '%-26s %s\n' "$1" "$2"; }

echo "── code ─────────────────────────────────────────────"
if REPO=$(git -C "${WEBUI_REPO:-$(dirname "$0")/../..}" rev-parse --show-toplevel 2>/dev/null); then
  say "branch"  "$(git -C "$REPO" branch --show-current 2>/dev/null)"
  say "commit"  "$(git -C "$REPO" rev-parse HEAD 2>/dev/null)"
  say "dirty"   "$(git -C "$REPO" status --porcelain 2>/dev/null | wc -l | tr -d ' ') files"
  say "SEAM_ANCHOR" "$(grep -oE 'const SEAM_ANCHOR = [a-z]+' "$REPO/webui/src/routes/studio/compose.ts" 2>/dev/null | awk '{print $4}')"
else
  say "branch" "(not a git checkout)"
fi

echo "── harness ──────────────────────────────────────────"
# The image the CONTAINER runs, by digest. The tag is not the answer: :latest
# moves, and a container keeps whatever it was created from.
say "container status" "$(docker inspect harness --format '{{.State.Status}}' 2>/dev/null || echo missing)"
IMGID=$(docker inspect harness --format '{{.Image}}' 2>/dev/null)
say "image id" "${IMGID:-—}"
if [ -n "${IMGID:-}" ]; then
  say "image digest" "$(docker image inspect "$IMGID" --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}(local build, no digest){{end}}' 2>/dev/null)"
  say "image created" "$(docker image inspect "$IMGID" --format '{{.Created}}' 2>/dev/null)"
fi
say "COMFY_VERSION" "$(docker exec harness sh -c 'echo $COMFY_VERSION' 2>/dev/null || echo '—')"
say "run.sh md5" "$( { md5 -q "$AUTEUR/run.sh" 2>/dev/null || md5sum "$AUTEUR/run.sh" 2>/dev/null | cut -d' ' -f1; } )"
say "nodes.lock md5" "$( { md5 -q "$AUTEUR/nodes.lock" 2>/dev/null || md5sum "$AUTEUR/nodes.lock" 2>/dev/null | cut -d' ' -f1; } )"
say "comfy pin" "$(grep -oE 'ComfyUI\.git [a-f0-9]+' "$AUTEUR/nodes.lock" 2>/dev/null | awk '{print $2}')"
say "deploy-sha" "$(cat "${XDG_DATA_HOME:-$HOME/.local/share}/video-harness/.modal-deploy-sha" 2>/dev/null || echo NONE)"

echo "── reachable ────────────────────────────────────────"
say "harness api" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
  -H 'Host: host.docker.internal:19006' -H 'content-type: application/json' -d '{"req":{}}' \
  http://localhost:19006/workspaces/probe@1.0/api/poll-state 2>/dev/null)"
say "studio" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:5290/studio 2>/dev/null)"

echo "── env (names and lengths only) ─────────────────────"
for k in MODAL_WORKSPACE MODAL_API_KEY MODAL_API_SECRET MODAL_GPU_KEYS COMFY_VERSION \
         AWS_ACCESS_KEY AWS_SECRET_KEY AWS_REGION S3_BUCKET \
         GROK_API_KEY CIVITAI_TOKEN HF_TOKEN SANDBOX_BACKEND; do
  v=$(grep -m1 "^${k}=" "$AUTEUR/.env" 2>/dev/null | cut -d= -f2-)
  case "$k" in
    MODAL_WORKSPACE|MODAL_GPU_KEYS|COMFY_VERSION|AWS_REGION|SANDBOX_BACKEND)
      say "$k" "${v:-(empty)}" ;;                       # not secret, and they must match
    *)
      say "$k" "$([ -n "$v" ] && echo "set, ${#v} chars" || echo MISSING)" ;;
  esac
done
