# The Prompt Registry

Every static instruction Nexora sends to a model lives in one registry and is
read back through one resolver. The owner sees all of it in **Settings →
Prompts**, can edit any of it, and can always put the original back.

This is architecture, not a settings screen. A prompt that is not registered
cannot be found, edited, exported or reset by the owner — which is exactly the
problem this exists to end.

---

## The rule

**No new static prompt may be added to Nexora without registering it here.**

Whenever a feature introduces a system instruction, a role brief, a behavioural
rule, or a message Nexora composes and sends to an agent, that text must:

1. have a stable id (`lower-case-words-with-hyphens`, never derived from the name);
2. have a name and a description written for the owner, not for a developer;
3. have a category;
4. have a version, starting at 1;
5. have its built-in text in source control, under `src/lib/prompts/defs/`;
6. be registered with `registerPrompt`;
7. be read at runtime with `getPrompt` / `renderPrompt` and never as an imported constant.

Everything else — appearing in Settings → Prompts, owner customization, reset,
history, export and import — then happens automatically. There is nothing to
wire up per prompt.

A feature that adds a prompt is not finished until this is done. It is part of
Nexora's Definition of Done.

### What is deliberately *not* in the registry

Not every string that reaches a model is an instruction:

- **tool names, JSON schemas and tool descriptions** — these are a protocol the
  code validates against, not prose; editing one would break the tool;
- **tool result texts** (what a tool hands back after it runs);
- **owner-facing UI text** — page copy, task history entries, Needs You titles,
  activity labels. These are read by a person, not a model;
- **runtime values** substituted into a prompt (`{{findings}}`, `{{project_state}}`,
  a task title). These are data, not settings.

If you are unsure: does a model read it, and did a human write it as an
instruction? If both, it belongs in the registry.

---

## How to register a prompt

Add it to the definition module for its category (or create one and import it
from `src/lib/prompts/index.ts`):

```ts
// src/lib/prompts/defs/sales.ts
import { registerPrompt } from "../registry";

registerPrompt({
  id: "sales-outreach-rule",
  name: "Sales outreach",
  description: "How sales agents open a conversation with someone who has not asked to be contacted.",
  category: "other",
  version: 1,
  required: true,
  usedBy: ["Agents in Sales"],
  placeholders: ["company_name"],
  defaultContent: `# Outreach (mandatory rule)
Never contact anyone who has asked not to be…`,
});
```

Then use it — and only use it — through the resolver:

```ts
import { getPrompt, renderPrompt } from "@/lib/prompts";

parts.push(getPrompt("sales-outreach-rule"));
const message = renderPrompt("sales-outreach-rule", { company_name: profile.name });
```

`registerPrompt` refuses an id that is not a stable slug, a prompt with no name,
description, content or version, and two different prompts claiming one id.

### Fields

| field | meaning |
|---|---|
| `id` | stable forever; overrides, exports and history are keyed by it |
| `name` / `description` | what the owner reads in Settings → Prompts |
| `category` | one of the categories in `src/lib/prompts/types.ts` — keep the list short |
| `version` | bump when you change `defaultContent`; a customization made from an older version is then shown as "update available" rather than being overwritten |
| `placeholders` | the `{{names}}` Nexora fills in at call time, listed under the editor |
| `usedBy` | where this text ends up, in the owner's words |
| `required` | the product cannot run without it: an empty customization is refused |
| `defaultContent` | the built-in text. It stays in source control and is never written to by the app |

---

## How resolution works

```
getPrompt("manager-management-rule")
        │
        ├── the owner has an override for this id ──→ their text
        └── otherwise                              ──→ defaultContent from source
```

That decision is made in exactly one place (`src/lib/prompts/registry.ts`). No
other module checks for a customization, which is why "reset to default" can be
trusted: the built-in was never touched, so removing the override restores it.

`renderPrompt(id, vars)` resolves and then substitutes `{{placeholders}}`. The
Capability Manager's own texts use single braces (`{shortId}`) and their own
`render`, for historical reasons; both read their text from the registry.

## Composition

Nexora does **not** keep one giant prompt per agent. A system prompt is
assembled from small registered pieces, and which pieces an agent gets depends
on its permissions and its place in the org chart:

```
# Identity, instructions, skills, granted tools   (the agent's own record)
agent-autonomy-rule                               (everyone)
credential-handling-rule                          (if it may use credentials)
payment-handling-rule                             (if it may spend)
company-profile-rule                              (if it may read company data)
browser-behavior-rule                             (if it has the browser)
company-profile-write-rule                        (if it may write company data)
task-execution-rule                               (everyone)
capability-manager-playbook | request-capability-note | manager-capability-note
manager-management-rule + delegation-rule         (if people report to it)
ceo-coordination-rule                             (if its reports manage people)
agent-closing-line                                (everyone)
```

**The order is behaviour.** The management rule is last on purpose: it decides
whether the "do it yourself" rules above it are addressed to this agent at all.
Do not reorder without meaning to, and say so if you do.

A shared rule is defined once and referenced. `credential-handling-rule` is not
copied into the CEO, manager and employee prompts — they all resolve the same
definition, so editing it once changes every agent that carries it.

## Storage

- built-in text: `src/lib/prompts/defs/*.ts` (source control)
- owner overrides: `promptOverrides` in `data/nexora.json`
- history: `promptRevisions` in `data/nexora.json`, the last 20 changes per prompt

An override records the built-in version it was written from, so a later change
to the default is surfaced as "update available" instead of silently replacing
the owner's text.

## Import and export

Export is a versioned JSON file keyed by prompt id:

```json
{
  "format": "nexora-prompts",
  "version": 1,
  "exported_at": "2026-09-16T10:00:00.000Z",
  "prompts": [
    {
      "id": "manager-management-rule",
      "name": "Manager management rule",
      "description": "How a manager turns work brought to it into work its team actually does.",
      "category": "management",
      "built_in_version": 1,
      "customized": true,
      "content": "…"
    }
  ]
}
```

Import is always two steps: preview, then apply only what the owner ticked.
Each entry is judged as **update** (the built-in is in use and the file differs),
**conflict** (the owner has their own version — never applied unless ticked),
**unchanged**, **unknown** (no such id in this Nexora; skipped, never created),
or **invalid** (empty or too long).

## Tests

- `scripts/test-prompts.mjs` — registration, resolution, edit, reset, history,
  restore, composition, order, export, import preview, conflicts, round trip,
  and where overrides are stored.
- `scripts/test-prompt-parity.mjs` — captures the assembled system prompts of
  ten differently-shaped agents and the messages Nexora sends them, so a change
  to prompt plumbing can be proved not to have changed a single character.
- `scripts/test-isolated.mjs` — overrides, history and reset across a real restart.
