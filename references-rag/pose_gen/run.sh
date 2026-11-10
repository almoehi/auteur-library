#!/usr/bin/env bash
# Runs one job file of the pose generator (pose_gen/README.md) in the fat-image container `harness`.
#
#   POSE_GEN_WORKSPACE=<host job dir> REFS_LIBRARY_ROOT=<nsfw-poses-references> pose_gen/run.sh <jobs.json> [INFLIGHT]
#
# The container mounts only <video-harness>/release/workflows as /work/workflows, so POSE_GEN_WORKSPACE must be a
# dir below it (default container path: /work/workflows/_mannequin/pose_gen, override with POSE_GEN_DIR). The
# runner, harness.cjs and the two library line-art samples of the style edit are copied into it. Real GPU (Modal
# l40s): the runner tears its endpoint down in `finally`; still check for orphaned containers afterwards. Run ONE
# REPL script at a time (concurrent REPLs break the bridge patch below).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
jobs="${1:?usage: run.sh <jobs.json> [INFLIGHT]}"
inflight="${2:-2}"
WS="${POSE_GEN_WORKSPACE:?set POSE_GEN_WORKSPACE (host dir below release/workflows)}"
LIB="${REFS_LIBRARY_ROOT:?set REFS_LIBRARY_ROOT (the nsfw-poses-references checkout)}"
DIR="${POSE_GEN_DIR:-/work/workflows/_mannequin/pose_gen}"
BRIDGE=/golem-app/golem-temp/repl/ts/node_modules/@golemcloud/golem-ts-bridge/dist/index.mjs

mkdir -p "$WS/style"
cp "$HERE/run_jobs.ts" "$HERE/harness.cjs" "$WS/"
# Picture 2 of the style edit (build_jobs.py STYLE_REF): library duo/P009 and full_body_sexy/P031 front line art.
cp "$LIB/pose_pngs/duo/seated_back_facing/pair60_P009_front.png" "$WS/style/lib_P009_line.png"
cp "$LIB/pose_pngs/solo/full_body_sexy/kneeling_all_fours/full_sexy_P031_front.png" "$WS/style/lib_solo_line.png"

# The REPL's node_modules appear on its first run after a container (re)start; the bridge then needs the
# trailing-slash fix (otherwise every agent call hits `//v1/...` and fails with "Not Found").
if ! docker exec harness test -f "$BRIDGE"; then
  echo 'console.log("repl ready");' > "$WS/.repl_init.ts"
  docker exec harness bash -c 'cd /golem-app && golem -E "$(cat /tmp/deploy-app.env)" repl --script-file "$0" --yes' "$DIR/.repl_init.ts" >/dev/null
  rm -f "$WS/.repl_init.ts"
fi
docker exec harness perl -pi -e 's{baseUrl = server\.url;}{baseUrl = server.url.replace(/\\/+\$/, "");}' "$BRIDGE"

docker exec -e JOBS="$jobs" -e INFLIGHT="$inflight" -e POSE_GEN_DIR="$DIR" harness bash -c \
  'cd /golem-app && AWS_ACCESS_KEY="$APP_AWS_ACCESS_KEY" AWS_SECRET_KEY="$APP_AWS_SECRET_ACCESS_KEY" \
     golem -E "$(cat /tmp/deploy-app.env)" repl --script-file "$POSE_GEN_DIR/run_jobs.ts" --yes'
