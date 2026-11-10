/**
 * REPL driver of the pose generator (pose_gen/README.md; runs in the harness container, copied by run.sh next to
 * its job files with harness.cjs):
 * load -> provision -> run the jobs of $JOBS with at most $INFLIGHT (default 2) in flight -> download -> teardown.
 * The Modal endpoint scales a container down after 2 s idle, so inputs are staged BEFORE the loop and the loop
 * polls every second: the next job is submitted before the container that just finished goes away (a cold start
 * costs ~100 s of GPU time; a warm job ~40 s).
 * Env: JOBS (job JSON name in POSE_GEN_DIR), INFLIGHT (default 2), POSE_GEN_DIR (container path).
 */
const _path = require("node:path") as typeof import("node:path");
const _fs = require("node:fs") as typeof import("node:fs");
const WORK_DIR = process.env.WORK_DIR ?? "/work";
// The job dir as the container sees it (run.sh passes it); harness.cjs is copied next to this script.
const DIR = process.env.POSE_GEN_DIR ?? _path.join(WORK_DIR, "workflows", "_mannequin", "pose_gen");
const { stageFile } = require(_path.join(DIR, "harness.cjs"));
const INFLIGHT = Number(process.env.INFLIGHT ?? 2);
const spec = JSON.parse(_fs.readFileSync(_path.join(DIR, process.env.JOBS ?? "jobs.json"), "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const profile = JSON.stringify({ tier: "standard", profile: { compute: { backend: "modal", gpuType: spec.gpu, timeoutSec: 5400, maxAttempts: 2 } } });

const agent = await WorkflowAgent.get(spec.wf, `newposes-${spec.wf}@${Date.now()}`);
try {
  const bundle = _path.join(WORK_DIR, "workflows", spec.wf);
  const manifest = JSON.parse(await agent.loadFromContent(spec.wf, _fs.readFileSync(_path.join(bundle, "workflow.json"), "utf8"), _fs.readFileSync(_path.join(bundle, "workflow.yaml"), "utf8")));
  if (manifest.error) throw new Error(`loadFromContent failed: ${manifest.error}`);
  await agent.provision();
  for (;;) {
    const st = JSON.parse(await agent.backendStatus());
    if (st.status === "provisioned") break;
    if (st.status === "failed") throw new Error(`Provisioning failed: ${st.error}`);
    await sleep(15_000);
  }
  const staged: Record<string, string>[] = [];
  for (const job of spec.jobs) {
    const inputs: Record<string, string> = {};
    for (const [port, file] of Object.entries(job.inputs ?? {})) inputs[port] = await stageFile("mannequin-new-poses", _path.join(DIR, file as string));
    staged.push(inputs);
  }
  const queue = [...spec.jobs.entries()];
  const running = new Map<string, { i: number; file: string; t: number }>();
  let ok = 0, failed = 0;
  const deadline = Date.now() + 90 * 60 * 1000;
  while ((queue.length || running.size) && Date.now() < deadline) {
    while (queue.length && running.size < INFLIGHT) {
      const [i, job] = queue.shift()!;
      const id = await agent.run(profile, JSON.stringify(staged[i]), JSON.stringify(job.params), undefined, undefined, undefined, undefined);
      if (id.startsWith("{")) { console.log(`  REFUSED ${job.file}: ${JSON.parse(id).error}`); failed++; continue; }
      running.set(id, { i, file: _path.join(DIR, job.file), t: Date.now() });
    }
    await sleep(1_000);
    for (const [id, r] of [...running]) {
      const res = JSON.parse((await agent.runStatus(id)) ?? "null");
      if (res?.phase === "succeeded") {
        running.delete(id);
        const next = queue.shift();  // submit before downloading: keep the container busy
        if (next) {
          const nid = await agent.run(profile, JSON.stringify(staged[next[0]]), JSON.stringify(next[1].params), undefined, undefined, undefined, undefined);
          if (nid.startsWith("{")) { console.log(`  REFUSED ${next[1].file}: ${JSON.parse(nid).error}`); failed++; }
          else running.set(nid, { i: next[0], file: _path.join(DIR, next[1].file), t: Date.now() });
        }
        const resp = await fetch(res.outputs[0].url);
        _fs.writeFileSync(r.file, Buffer.from(await resp.arrayBuffer()));
        console.log(`  SAVED ${r.file} (${Math.round((Date.now() - r.t) / 1000)}s)`); ok++;
      } else if (res?.phase === "failed") {
        console.log(`  FAILED ${r.file}: ${res.failure?.kind} ${res.failure?.message}`); failed++; running.delete(id);
      }
    }
  }
  for (const r of running.values()) console.log(`  TIMED OUT ${r.file}`);
  console.log(`DONE ok=${ok} failed=${failed}`);
} finally {
  await agent.teardown();
  console.log("teardown completed");
}
