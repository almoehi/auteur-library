Second note, unrelated to the reference-image one — timing. Local harness,
Modal a100, MiniMax H3, one clip per workspace.

**Model loading dominates the render, and every render pays it.** Timed two
5-second clips that differ only in frame size:

| frame | pixels | render (job.start → prompt.completed) |
|---|---|---|
| 576x1024 | 590k | 124s |
| 288x512 | 147k | 122s |

A quarter of the pixels, two seconds. So sampling is a small part of that 122s
and the rest is container start, ComfyUI boot and loading 35–40GB of models from
the volume. With `scaledown_window=2` on ComfyWorker the container dies two
seconds after going idle, so that cost is paid in full on every single render —
nothing is ever warm.

Would a larger scaledown window be reasonable for interactive use? Iterating on
a prompt means five or six renders in twenty minutes, and each one currently
reloads everything. I understand the tradeoff is billed idle GPU; I mainly want
to know whether it is configurable per deployment or deliberately pinned at the
minimum.

**Where the rest of the wait goes.** Same clip, end to end, 4m57s:

- 3s — studio composes and opens the workspace (measured, ours, not the problem)
- 37s — harness creates the task and gets it running
- 102s — task running → GPU job starts: the worker agent's LLM turns plus
  workflow provisioning
- 124s — render
- 34s — clip saved, artifact approved, poller notices

I tried two things against that 102s and neither helped. `lazy: false` on the
workflow entry got the task running at +6s instead of +37s, but the GPU started
*later*, and end to end it was 302s against 297s. Moving the worker agent from
grok-4.5 to grok-fast likewise changed nothing measurable — though it does work,
including relaying explicit prompt text, if that is useful to know.

So the 102s is not something I can reach from the workspace spec. Is it mostly
provisioning, or mostly the agent's own turns? If provisioning, is there a way to
warm an endpoint before a task needs it?

Nothing here is urgent. The clips come out; they just take five minutes, of which
about forty seconds is generating images.
