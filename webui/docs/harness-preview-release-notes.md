Third note. Preview release running since this morning, plus numbers that settle
the timing question from the last one. Nothing here is urgent; two of the three
findings are things you may simply want to know.

---

## 1. The preview release: one real break, and it is a good one

`flattenModelPaths` going away is a behaviour change worth calling out, because
it turned an invisible mismatch into a hard prefetch failure for us.

Our bundle's rgthree Power Lora Loader referenced adapters as
`MINIMAX\name.safetensors` — the backslash the ComfyUI export wrote. The old
release flattened that before storing the graph, so the renderer only ever saw
the basename and everything worked. The new one stores the graph as written and
`validateModelCoverage` compares it against the declared filenames, so we got:

```
WorkflowDownloader: workflow "...foxydit" references models not declared
in the models stanza:
  loras/MINIMAX\minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors
```

Correct behaviour, clear message, and the fix was ours to make — we now write
bare filenames, which is what was actually on the volume all along. Flagging it
only because anyone else carrying a Windows-exported graph will hit it, and the
error names the symptom rather than the change.

One more on model declarations, and this one costs disk rather than a failure:
the same two files are declared three different ways across the registry. The
MiniMax turbo and ref loras are flat in `krea2_character_sheet`, under
`Minimax/` in `krea2_location_sheet`, and the H3 unet and VAEs are under
`MinimaxH3/` and `h3/` in both while our own bundle has them flat. Each workflow
is internally consistent, so nothing breaks — but the volume ends up holding
three copies of a 19.5 GB unet and several of the loras, and each new convention
costs a fresh download the first time a workflow that uses it runs. Worth a
convention, or a normalisation step, if you have not already got one planned.

Also: `dest:` in a models stanza appears to be inert. We had `dest: loras/MINIMAX/`
declared for a year and the files were always written flat — the download payload
only carries `dest_type` and `filename`. If that field is genuinely unsupported,
it might be worth rejecting it rather than ignoring it.

Everything else came through clean. All 33 API endpoints we call still exist,
`poll-state`'s `queue_depth` → `in_flight`/`pending` was the only shape change,
and our workspaces validate unmodified apart from adding `defaultTaskModel`.

## 2. A workspace agent can wedge while the harness stays healthy

During our first character-sheet render, one workspace stopped answering every
call for its own id for about ten minutes:

```
openapi.yaml                       200 in 0.09s
direct-...-direct@1.0  is-open     200 in 0.07s
sheet-...-sheet@1.0    is-open     000 after 25s (timeout)
```

The harness was fine, every other workspace was fine, and the render was still
progressing on the GPU the whole time. It recovered on its own once the render
finished. No errors in the container log.

Not a crash, then — but from the outside it is indistinguishable from one, and
our UI told the operator to restart the container, which would have killed a
render that was still running. We now probe the harness before claiming anything.
Mentioning it in case a long-running tool call blocking the agent's own API
surface is fixable, or at least expected.

## 3. Timing: the answer, with numbers

The last note guessed that model loading dominates. It does, and by more than I
expected. Four experiments, each varying one thing:

| varied | from | to | result |
|---|---|---|---|
| GPU tier | l40s | h100 | 175s → 170s |
| orbit frame count | 124 | 32 | 175s → 166s |
| clip frame size | 147k px | 590k px | 122s → 124s |
| **models loaded** | **56.7 GB** | **17.1 GB** | **175s → 24s** |

The first three are noise. The fourth is the whole thing.

Fitting the frame-count pair gives roughly **0.1s per frame on top of ~163s that
does not move**, so of a 175s character-sheet render, about **twelve seconds is
sampling**. That is why a better card changes nothing: there is almost no compute
in these renders to accelerate. The only lever that moved was cutting the
workflow down to the models it actually needs — we serve the KREA-2 half of
`krea2_character_sheet` as its own bundle for cheap previews, which drops the H3
suite and lands at 24s and 29s across two runs.

**And the fixed cost is paid twice per render.** From one preview, timestamps
straight out of the Modal app log:

```
11:37:35  job.start        worker.prefetch-models
11:38:11  three models verified, all download.cached — nothing fetched
11:39:16  job.start        worker.<render>
11:39:40  prompt.completed
```

101 seconds from prefetch start to render start, of which 36 is the verification
and 65 is a second container cold-starting because the first one exited. The next
run checked *seven* models instead of three and took 101 seconds again — so that
number is container startup, not file work.

So the three things I would look at, in order:

1. **`scaledown_window=2`** on `ComfyWorker`. Every render pays a full cold start,
   and a prefetch immediately followed by a render pays two.
2. **`enable_memory_snapshot`** is not set. This workload — large static weights,
   short execution — is close to the case Modal's memory snapshotting is for.
3. **`@modal.enter()` is `pass`** and ComfyUI starts lazily inside `run()`, so
   nothing is warm even when a container is reused.

I have not touched any of these; deploy.py is yours and I did not want to fork it.

## 4. Small one: GPU selection is cheapest-first, which surprised me

A workflow declaring `gpu_types: [l40s, a100, h100]` gets the cheapest, even when
the render profile asks for a100 — the profile's `gpuType` never wins against the
allowlist. Our character sheets ran on l40s for a while without us noticing.

Given the numbers above that turned out to be the right card anyway, so this is
not a complaint — but the profile field reads like a request that will be
honoured, and it is not. Either documenting it or dropping the field would save
someone the confusion.

---

The three new workflows are excellent, incidentally. The character sheet is the
piece we were missing: our tool makes 5-second clips and the survey work says
people want half a minute to several, with a consistent face across shots. Sheet
plus continuation is exactly that path, and the sheets are coming out well —
including from Hungarian input, though we now translate first.
