# Render-bundle experiment patches

Each file is an `AUTEUR_WF_PATCH` patch (see `webui/src/routes/studio/wfpatch.server.ts`).
Point the studio at one with `AUTEUR_WF_PATCH=<absolute path>` in `webui/.env` and
restart it. Every patch here needs preflight on, because the worker only installs
customNodes then; the patch forces that itself.

| file | what it does | measured 2026-09-23, b200, warm, ComfyUI time |
|---|---|---|
| `ray2.json` | Raylight sequence parallel on 2 GPUs (`gpuCount: 2`) | 5 s clip 45 s, 10 s clip 64 s (1 GPU: 44 s / 64 s) |
| `ray4.json` | the same on 4 GPUs (`gpuCount: 4`) | 5 s clip 23.5 s, 10 s clip 34 s |
| `vdn-turbo.json` | VDN-H3 hybrid attention + its 8-step Turbo adapter, 1 GPU | 10 s clip 6.6 s/it against SolAttn's 6.0: no gain |

Things these depend on, each learned the hard way:

- Raylight comes from our fork, `dszab8/raylight` @ `070a038`, upstream main with
  `xfuser==0.4.5` pinned. Upstream resolves xfuser 0.6, which kills the Ray workers
  on `envs.get_device_name`. Upstream's `dev` branch needs ComfyUI 0.35.
- `sync_ulysses` must be true. Async Ulysses corrupted the lower part of every
  frame on 10 s clips, on both 2 and 4 GPUs.
- Raylight main has no `cond_audio` segment (upstream issue #111), so continuations
  that carry the prior clip's audio are not expected to work. Direct renders do.
- Changing the RayInitializer settings inside a warm container broke ComfyUI's
  restart ("did not become ready within 300s"). Keep one setting per container.
- Cold starts are expensive with Raylight (220-400 s: pip, Ray, a model load per
  worker), so it only pays with warm containers.
- VDN needs `dszab8/ComfyUI-VDN-Paths` so the stage can live under
  `diffusion_models/vdn/`. The harness cannot write to `models/vdn`. Small
  Hugging Face files must use `/raw/main/` URLs: `/resolve/` redirects them
  relatively and aria2c fails.
