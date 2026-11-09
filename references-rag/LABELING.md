# Labelling runbook (agent jobs)

Labels are produced by Claude Code subagents (Sonnet) in a Claude Code session, exchanged through
files - no API key. Every job is resumable: only items without a valid result for their current
sha256 are batched, and a batch counts only when its whole output validates.

```sh
uv run refs jobs make outfit_vision     # writes jobs/outfit_vision/batches/batch_NNNN.json
# run one Sonnet agent per batch file (in parallel waves, e.g. 12 at a time) with the prompt:
#   "Do the agent job described in <batch.prompt>. Your batch file is <batch file>."
uv run refs jobs collect outfit_vision  # validates outputs, merges into results.jsonl
# re-run `make` + the agents for batches listed as pending, until none are left
```

| Job | Batch size | Record | Prompt |
|---|---|---|---|
| `outfit_vision` | 20 outfits | `labels.OutfitVision` | `jobs/outfit_vision/PROMPT.md` |
| `pose_vision` | 4 poses (up to 5 views each) | `labels.PoseVision` | `jobs/pose_vision/PROMPT.md` |
| `qa_outfit`, `qa_pose` | as above, 5% sample | same | same prompts (agreement gate) |
| `concept_affinity` | 100 items, text only | `labels.ConceptAffinity` | phase P3 |

`results.jsonl` of each job is committed: these are the labels. `batches/` and `out/` are not.
