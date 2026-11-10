/**
 * COPIED from video-harness toolchain/mannequin-sheet/harness.cjs for the pose generator (pose_gen/README.md);
 * run_jobs.ts uses only stageFile(). Credentials come from the container env (S3_BUCKET, AWS_ACCESS_KEY,
 * AWS_SECRET_KEY - run.sh maps them), never from this file.
 *
 * Shared helpers of the mannequin-sheet REPL scripts (krea_sheet.ts): S3 fixture staging
 * (SigV4, no SDK) and a load -> provision -> run ->
 * download -> teardown loop over one workflow bundle under $WORK_DIR/workflows.
 * Required by absolute path from the scripts (the REPL's cwd is golem-temp/repl/ts).
 * Not built on video-harness/e2e/lib/workflow-e2e.cjs: the fat-image container mounts only
 * workflows/ (as /work/workflows), so that library is not reachable from these scripts.
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const https = require("node:https");

const WORK_DIR = process.env.WORK_DIR ?? "/work";
const S3_BUCKET = process.env.S3_BUCKET ?? "";
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY ?? "";
const AWS_SECRET_KEY = process.env.AWS_SECRET_KEY ?? "";
const S3_HOST = `${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com`;
if (!S3_BUCKET || !AWS_ACCESS_KEY || !AWS_SECRET_KEY) {
  throw new Error("S3_BUCKET, AWS_ACCESS_KEY and AWS_SECRET_KEY must be set");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Render profile on `gpuType` of the configured compute backend. */
function profile(gpuType) {
  return JSON.stringify({
    tier: "standard",
    profile: {
      compute: { backend: process.env.COMPUTE_BACKEND ?? "modal", gpuType, timeoutSec: 5400, maxAttempts: 2 },
    },
  });
}

function amzDate() {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return { ts, day: ts.slice(0, 8) };
}

function signingKey(day) {
  const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
  return hmac(hmac(hmac(hmac(`AWS4${AWS_SECRET_KEY}`, day), AWS_REGION), "s3"), "aws4_request");
}

const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** Presigned GET URL of `key`. */
function presignGet(key, expiresIn = 14400) {
  const { ts, day } = amzDate();
  const scope = `${day}/${AWS_REGION}/s3/aws4_request`;
  const query = [
    "X-Amz-Algorithm=AWS4-HMAC-SHA256",
    `X-Amz-Credential=${encodeURIComponent(`${AWS_ACCESS_KEY}/${scope}`)}`,
    `X-Amz-Date=${ts}`,
    `X-Amz-Expires=${expiresIn}`,
    "X-Amz-SignedHeaders=host",
  ].join("&");
  const canon = ["GET", "/" + key, query, `host:${S3_HOST}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const sts = ["AWS4-HMAC-SHA256", ts, scope, sha256Hex(canon)].join("\n");
  const sig = crypto.createHmac("sha256", signingKey(day)).update(sts).digest("hex");
  return `https://${S3_HOST}/${key}?${query}&X-Amz-Signature=${sig}`;
}

function signedHeaders(method, key, body, contentType) {
  const { ts, day } = amzDate();
  const hash = sha256Hex(body);
  const pairs = [["host", S3_HOST], ["x-amz-content-sha256", hash], ["x-amz-date", ts]];
  if (contentType) pairs.push(["content-type", contentType]);
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const names = pairs.map(([k]) => k).join(";");
  const canonHdrs = pairs.map(([k, v]) => `${k}:${v}`).join("\n") + "\n";
  const canon = [method, "/" + key, "", canonHdrs, names, hash].join("\n");
  const scope = `${day}/${AWS_REGION}/s3/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", ts, scope, sha256Hex(canon)].join("\n");
  const sig = crypto.createHmac("sha256", signingKey(day)).update(sts).digest("hex");
  return {
    ...Object.fromEntries(pairs),
    authorization: `AWS4-HMAC-SHA256 Credential=${AWS_ACCESS_KEY}/${scope}, SignedHeaders=${names}, Signature=${sig}`,
  };
}

function s3Request(method, key, body, contentType) {
  return new Promise((resolve, reject) => {
    const headers = signedHeaders(method, key, body, contentType);
    if (body.length) headers["content-length"] = body.length;
    const req = https.request({ hostname: S3_HOST, path: "/" + key, method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    if (body.length) req.write(body);
    req.end();
  });
}

/**
 * Upload `localPath` to `<prefix>/<stem>_<content hash>.<ext>` unless it is there, and return a
 * presigned GET URL. The content hash in the key means a changed file never reuses a stale object.
 */
async function stageFile(prefix, localPath, contentType = "image/png") {
  const data = fs.readFileSync(localPath);
  const ext = path.extname(localPath);
  const key = `${prefix}/${path.basename(localPath, ext)}_${sha256Hex(data).slice(0, 16)}${ext}`;
  if ((await s3Request("HEAD", key, Buffer.alloc(0))) !== 200) {
    const status = await s3Request("PUT", key, data, contentType);
    if (status !== 200) throw new Error(`S3 PUT failed for ${key}: HTTP ${status}`);
    console.log(`  [upload] ${key} (${data.length} bytes)`);
  }
  return presignGet(key);
}

async function download(url, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`GET ${file}: HTTP ${resp.status}`);
      fs.writeFileSync(file, Buffer.from(await resp.arrayBuffer()));
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(5_000);
    }
  }
}

/**
 * Load + provision the bundle `wfName`, submit every job at once, save each job's first output
 * as `job.file` and log its render time; the endpoint is always torn down.
 * @param WorkflowAgent the REPL's auto-imported agent class
 * @param jobs `{ inputs, params, file }[]`
 */
async function renderAll(WorkflowAgent, wfName, gpuType, jobs) {
  const bundle = path.join(WORK_DIR, "workflows", wfName);
  const agent = await WorkflowAgent.get(wfName, `mannequin-${wfName}@${Date.now()}`);
  try {
    const manifest = JSON.parse(
      await agent.loadFromContent(
        wfName,
        fs.readFileSync(path.join(bundle, "workflow.json"), "utf8"),
        fs.readFileSync(path.join(bundle, "workflow.yaml"), "utf8"),
      ),
    );
    if (manifest.error) throw new Error(`loadFromContent failed: ${manifest.error}`);
    const provisionStart = Date.now();
    await agent.provision();
    for (;;) {
      const st = JSON.parse(await agent.backendStatus());
      if (st.status === "provisioned") break;
      if (st.status === "failed") throw new Error(`Provisioning failed: ${st.error}`);
      console.log(`  [${wfName}] ${st.status}`);
      await sleep(20_000);
    }
    console.log(`  [${wfName}] provisioned in ${Math.round((Date.now() - provisionStart) / 1000)}s`);
    const submitted = Date.now();
    const ids = [];
    const pending = new Set();
    for (const [i, job] of jobs.entries()) {
      const id = await agent.run(profile(gpuType), JSON.stringify(job.inputs), JSON.stringify(job.params), undefined, undefined, undefined, undefined);
      // run() never throws: a refusal comes back as JSON `{ error }` instead of a render id.
      const refusal = id.startsWith("{") ? JSON.parse(id).error : undefined;
      if (refusal) console.log(`  REFUSED ${job.file}: ${refusal}`);
      else pending.add(i);
      ids.push(id);
    }
    const deadline = Date.now() + 45 * 60 * 1000;
    while (pending.size > 0 && Date.now() < deadline) {
      for (const i of [...pending]) {
        const result = JSON.parse((await agent.runStatus(ids[i])) ?? "null");
        const secs = Math.round((Date.now() - submitted) / 1000);
        if (result?.phase === "succeeded") {
          await download(result.outputs[0].url, jobs[i].file);
          console.log(`  SAVED ${jobs[i].file} (+${secs}s after submit)`);
          pending.delete(i);
        } else if (result?.phase === "failed") {
          console.log(`  FAILED ${jobs[i].file} (+${secs}s): ${result.failure?.kind} ${result.failure?.message}`);
          pending.delete(i);
        }
      }
      if (pending.size > 0) await sleep(10_000);
    }
    for (const i of pending) console.log(`  TIMED OUT ${jobs[i].file}`);
  } finally {
    await agent.teardown();
    console.log(`  [${wfName}] teardown completed`);
  }
}

module.exports = { WORK_DIR, renderAll, stageFile };
