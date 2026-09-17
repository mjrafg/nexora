<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Definition of Done — static prompts

Whenever you finish a feature, ask: **did it add any static LLM prompt or system
instruction?**

If yes, the feature is not done until that text is registered in the Prompt
Registry (`src/lib/prompts/`) with a stable id, name, description, category,
version and built-in default, read at runtime through `getPrompt`/`renderPrompt`
rather than as an imported constant, and therefore visible in Settings → Prompts
with owner customization, reset, history and import/export.

No new static prompt may be added anywhere else in the codebase. See
`docs/prompts.md` for the API, the composition order, and what deliberately
stays out of the registry (tool schemas, tool results, owner-facing UI text).

# Definition of Done — skills

Skills are imported instruction documents (`src/lib/skills/`), not Nexora's own
text. They follow the opposite rule to prompts: **never edit an imported body.**
Re-import from a pinned upstream revision with `scripts/import-skills.mjs`, and
put anything Nexora needs to say about a document in that skill's `adaptation`
field, which is delivered above the body and clearly labelled as Nexora's.

A skill is guidance, never a grant. Adding one must not change tool permissions,
sandbox policy, or what any agent is allowed to reach. Delivery is by message —
never by appending to `buildSystemPrompt` — so an agent nobody selected a skill
for is assembled exactly as it was before the library existed.

Any new static text Nexora says *about* skills (how to choose them, how they are
introduced to an agent) is an ordinary static prompt and belongs in the Prompt
Registry under the rule above. See `docs/skills.md`.
