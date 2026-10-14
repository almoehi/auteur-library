/**
 * WorkflowAgent E2E (SPIKE) — flux2_reference_compose
 *
 * Question: can FLUX.2 (klein 9b kv) generate a NEW composition from reference images
 * (ReferenceLatent on an EmptyFlux2LatentImage of width x height) while keeping identity + place?
 *   a  character + location, low-angle      b  character + location, bird's-eye
 *   c  character only, new pose              d  baseline: no references (plain t2i)
 *   e  character + location, eye-level matching the plate (control: keeps the place?)
 *   f  reference order swapped (location Picture 1, character Picture 2)
 *   g  as (a) with a stronger style prompt
 *
 * Optional ports + chains: bindWorkflow() only strips the DIRECT consumer edge of an absent
 * optional loader, so this script loads a graph VARIANT per run that deletes the scale/encode/
 * reference nodes (positive + negative chain) of absent refs and re-chains the present ones.
 *
 * Reference URLs: `ref_urls.json` next to this file ({ character, location } presigned GET URLs;
 * never committed). Fixture PNGs of the two references are committed for provenance.
 *
 * Cost: REAL GPU (COMPUTE_BACKEND, l40s). Teardown in finally.
 *   docker exec harness bash -c 'cd /golem-app && golem -E "$(cat /tmp/deploy-app.env)" \
 *     repl --script-file /work/workflows/flux2_reference_compose/e2e-test.ts --yes'
 */

const WF_NAME = "flux2_reference_compose";
const GPU_TYPE = "l40s";
const COMPUTE_BACKEND = process.env.COMPUTE_BACKEND ?? "modal";
const PROVISION_TIMEOUT_MS = 35 * 60 * 1000;
const RENDER_TIMEOUT_MS = 30 * 60 * 1000;
const WIDTH = 1280;
const HEIGHT = 720;
const STEPS = 4;

const _path = require("node:path") as typeof import("node:path");
const _fs = require("node:fs") as typeof import("node:fs");
const WORK_DIR = process.env.WORK_DIR ?? "/work";
const FIXTURE_DIR = _path.join(WORK_DIR, "workflows", WF_NAME);

const RENDER_PROFILE = {
  tier: "standard",
  profile: {
    compute: { backend: COMPUTE_BACKEND, gpuType: GPU_TYPE, timeoutSec: 3600, maxAttempts: 1 },
  },
};

const STYLE = "A children's comic illustration with bold ink outlines and flat colours. ";
const BRIANNA =
  "Brianna, a young girl with dark braided pigtails, freckles and a yellow star hairclip, wearing mint-green star-pattern pajamas";

type PortName = "reference_image_1" | "reference_image_2" | "reference_image_3";
interface Case {
  id: string;
  refs: Partial<Record<PortName, "character" | "location">>;
  prompt: string;
}
const SCENE_LOW = "Low-angle shot from the floor, camera tilted up. ";
const SIGNS = "(the same room: window with a toy castle, door with a 'No Boys Allowed' sign, bookshelf)";
const CASES: Case[] = [
  {
    id: "a_lowangle_char_loc",
    refs: { reference_image_1: "character", reference_image_2: "location" },
    prompt: STYLE + SCENE_LOW + `Brianna from Picture 1 sits cross-legged on the bed in the bedroom from Picture 2 ${SIGNS}, looking up at the ceiling and smiling.`,
  },
  {
    id: "b_birdseye_char_loc",
    refs: { reference_image_1: "character", reference_image_2: "location" },
    prompt: STYLE + `Overhead bird's-eye view looking straight down. Brianna from Picture 1 lies on the bed in the bedroom from Picture 2 (the same room and furniture), arms spread wide, seen from directly above.`,
  },
  {
    id: "c_char_only_new_pose",
    refs: { reference_image_1: "character" },
    prompt: STYLE + "Brianna from Picture 1 running to the right in a dynamic three-quarter side view, mid-stride, laughing, full body, plain light background.",
  },
  {
    id: "d_baseline_no_refs",
    refs: {},
    prompt: STYLE + SCENE_LOW + `${BRIANNA} sits cross-legged on a bed in a grey child's bedroom with a window showing a toy castle, a door with a 'No Boys Allowed' sign and a bookshelf, looking up at the ceiling and smiling.`,
  },
  {
    id: "e_eyelevel_matching_plate",
    refs: { reference_image_1: "character", reference_image_2: "location" },
    prompt: STYLE + `Eye-level wide shot, camera at standing height facing the room, the same viewpoint as Picture 2. Brianna from Picture 1 stands next to the bed in the bedroom from Picture 2 ${SIGNS}, smiling at the camera.`,
  },
  {
    id: "f_swapped_order",
    refs: { reference_image_1: "location", reference_image_2: "character" },
    prompt: STYLE + SCENE_LOW + `Brianna from Picture 2 sits cross-legged on the bed in the bedroom from Picture 1 ${SIGNS}, looking up at the ceiling and smiling.`,
  },
  {
    id: "g_lowangle_style_boost",
    refs: { reference_image_1: "character", reference_image_2: "location" },
    prompt:
      "Flat 2D children's comic illustration, bold black ink outlines, flat cel colours, simple shading, not photorealistic, not 3D. " + SCENE_LOW +
      `Brianna from Picture 1 sits cross-legged on the bed in the bedroom from Picture 2 ${SIGNS}, looking up at the ceiling and smiling. Same art style as the pictures.`,
  },
];

/** Drops scale/encode/reference nodes (positive + negative chain) of absent refs and re-chains the present ones. */
function variantJson(baseJson: string, present: PortName[]): string {
  const g = JSON.parse(baseJson);
  const slots: PortName[] = ["reference_image_1", "reference_image_2", "reference_image_3"];
  let pos: [string, number] = ["135", 0];
  let neg: [string, number] = ["685", 0];
  slots.forEach((port, idx) => {
    const n = idx + 1;
    if (!present.includes(port)) {
      for (const id of [`41${n}`, `42${n}`, `43${n}`, `44${n}`]) delete g[id];
      return; // the LoadImage 40n stays as an orphan so the port binding still resolves
    }
    g[`43${n}`].inputs.conditioning = pos;
    g[`44${n}`].inputs.conditioning = neg;
    pos = [`43${n}`, 0];
    neg = [`44${n}`, 0];
  });
  g["138"].inputs.positive = pos;
  g["138"].inputs.negative = neg;
  return JSON.stringify(g);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const failures: string[] = [];

async function pollUntilDone(agent: any, renderId: string): Promise<any> {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  let lastPhase = "";
  while (Date.now() < deadline) {
    const result = JSON.parse((await agent.runStatus(renderId)) ?? "null");
    if (!result) throw new Error(`runStatus null for ${renderId}`);
    if (result.phase !== lastPhase) {
      console.log(`    phase=${result.phase} attempts=${result.attempts ?? 0}`);
      lastPhase = result.phase;
    }
    if (result.phase === "succeeded") return result;
    if (result.phase === "failed") {
      const f = result.failure ?? {};
      throw new Error(`render failed: kind=${f.kind ?? "?"} — ${f.message ?? "(no message)"}\n${JSON.stringify(result.logs ?? "").slice(0, 3000)}`);
    }
    await sleep(10_000);
  }
  throw new Error("render timed out");
}

const refUrls = JSON.parse(_fs.readFileSync(_path.join(FIXTURE_DIR, "ref_urls.json"), "utf8"));
const baseJson = _fs.readFileSync(_path.join(FIXTURE_DIR, "workflow.json"), "utf8");
const yaml = _fs.readFileSync(_path.join(FIXTURE_DIR, "workflow.yaml"), "utf8");
const agent = await WorkflowAgent.get(WF_NAME, `e2e-${WF_NAME}-${Date.now()}`);

try {
  console.log(`=== WorkflowAgent E2E (spike) — ${WF_NAME} ===`);
  const loaded = JSON.parse(await agent.loadFromContent(WF_NAME, baseJson, yaml));
  if (loaded.error) throw new Error(`loadFromContent failed: ${loaded.error}`);
  console.log(`  inputs=${JSON.stringify(loaded.inputs?.map((i: any) => i.name))}`);

  const t0 = Date.now();
  await agent.provision();
  for (;;) {
    const st = JSON.parse(await agent.backendStatus());
    if (st.status === "provisioned") break;
    if (st.status === "failed") throw new Error(`Provisioning failed: ${st.error}`);
    if (Date.now() - t0 > PROVISION_TIMEOUT_MS) throw new Error("provision timeout");
    await sleep(20_000);
  }
  console.log(`  provisioned in ${Math.round((Date.now() - t0) / 1000)}s`);

  // CASE_IDS=e_...,f_... (comma-separated) restricts the run to those cases.
  const only = (process.env.CASE_IDS ?? "").split(",").filter(Boolean);
  for (const c of CASES.filter((x) => only.length === 0 || only.includes(x.id))) {
    console.log(`\n── ${c.id} ──`);
    const ports = Object.keys(c.refs) as PortName[];
    // load() is idempotent (keeps the first manifest) — drop it so the variant graph takes effect.
    await agent.removeWorkflow();
    const re = JSON.parse(await agent.loadFromContent(WF_NAME, variantJson(baseJson, ports), yaml));
    if (re.error) throw new Error(`variant load failed: ${re.error}`);
    const media: Record<string, string> = {};
    for (const p of ports) media[p] = refUrls[c.refs[p]!];
    const start = Date.now();
    const renderId = await agent.run(
      JSON.stringify(RENDER_PROFILE),
      JSON.stringify(media),
      JSON.stringify({ prompt_positive: c.prompt, width: WIDTH, height: HEIGHT, steps: STEPS, seed: 4242 }),
      undefined, undefined, undefined, undefined,
    );
    try {
      const result = await pollUntilDone(agent, renderId);
      console.log(`  RESULT ${c.id} secs=${Math.round((Date.now() - start) / 1000)} url=${result.outputs?.[0]?.url}`);
    } catch (err) {
      console.log(`  ✗ ${c.id}: ${err}`);
      failures.push(`${c.id}: ${err}`);
    }
  }
} finally {
  try {
    await agent.teardown();
    console.log("  teardown() completed");
  } catch (err) {
    console.log(`  teardown threw: ${err}`);
  }
}
console.log(failures.length ? `FAILED:\n${failures.join("\n")}` : "ALL RENDERS OK");
