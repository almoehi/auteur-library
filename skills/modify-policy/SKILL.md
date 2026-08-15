---
name: modify-policy
description: >
  Use when the user wants to update, edit, change, or fix an existing policy — e.g.
  "change the policy prompt", "update the rubric", "fix the grading threshold".
  Guides the four-step replace sequence (unassign → delete → recreate → reassign).
  Do NOT invoke for creating a brand-new policy that does not yet exist.
agentType: workspace
---

# Modify an Existing Policy

Policies are immutable once created. To change a policy you must replace it:
**unassign → delete → create (updated) → reassign**.

---

## Step 1 — Identify the target

Call `policy_index` to find the policy's runtime id and which entities it is attached to.

---

## Step 2 — Unassign

```
unassign_policy(policy_id="<runtime-id>")
```

This detaches the policy from every task, artifact, and agent it is linked to.
Only dynamic policies can be unassigned — spec-origin policies (defined in the workspace YAML) cannot be modified this way.

---

## Step 3 — Delete

```
delete_policy(policy_id="<runtime-id>")
```

Removes the policy from the registry. The policy must be fully unassigned first.

---

## Step 4 — Recreate with the updated spec

```
create_policy(id="<same-or-new-id>", description="...", model="...", modality="...", grading="...", evalPrompt="...", ...)
```

Use the same `id` to keep naming consistent, or a new one if the policy's purpose changed significantly.

---

## Step 5 — Reassign

```
assign_policy(policy="<id-or-key>", target="<task-id-or-artifact-id>")
```

Repeat for each entity the old policy was attached to (from Step 1).

---

## Common mistakes

- Calling `create_policy` before `delete_policy` → duplicate key error
- Calling `delete_policy` before `unassign_policy` → "policy still assigned" error
- Forgetting to reassign after recreation → policy exists but evaluates nothing
