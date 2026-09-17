# Skills

A skill is an engineering method written down: how to chase a bug to its cause,
how to build an interface people can actually use, what to look for when
reviewing someone else's work. Nexora holds a small library of them and hands
out the few a piece of work needs — to that piece of work and nowhere else.

This is deliberately not "every agent knows everything". A document that is
always present is a document nobody reads and everybody pays for.

## Where the text comes from

`src/lib/skills/imported.ts` is generated, never hand-edited. It is produced by

```bash
node scripts/import-skills.mjs
```

which fetches the selected `SKILL.md` files and their supporting documents from
one pinned revision of [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)
and writes them out byte for byte, with the repository's LICENSE. The revision
is recorded in `SKILL_SOURCE.revision` and shown to the owner in
Settings → Skills and to every agent that reads a skill.

**Nexora never edits an upstream body.** Where a document assumes something that
is not true here — a tool the agent does not have, a workflow Nexora's engine
owns — that goes in the skill's `adaptation` in `src/lib/skills/library.ts`. It
is delivered *above* the body under a heading that says whose words they are:

```
# Skill: <name>
id: … · source: … @ <revision> · MIT

## How this applies in Nexora (Nexora's note, not the source's)
…

## The document, as published

<the upstream text, unchanged>
```

If a conflict is too deep to note around, the skill ships disabled with a
`disabledReason` the owner can read, rather than quietly rewritten.

## The boundary with the Prompt Registry

| | Prompt Registry | Skill library |
|---|---|---|
| Whose words | Nexora's | someone else's, imported |
| Owner can edit the text | yes | no |
| Owner control | edit, reset, revisions, import/export | one switch: available or not |
| Versioning | per-prompt `version` + revisions | one pinned upstream revision |

Two editable copies of the same paragraph is the confusion this boundary exists
to prevent. What Nexora *says about* skills — the catalog note the Director
reads, the wrapper around a delivered document, the repair reminder — is
Nexora's own text and lives in the registry (`src/lib/prompts/defs/skills.ts`).

## How a skill reaches a model

Selection is the Director's, from the work:

1. The Director's system assembly carries a **catalog** — ids, one line each,
   and roughly what each costs to read. No bodies. (Omitted entirely when no
   skill is available, so the assembly is unchanged from before the feature.)
2. Planning a milestone, the Director passes `skills` (for the Builder) and
   `reviewer_skills` (for that session's Reviewer) in `plan_milestone_sessions`.
   `planSessions` stores each as a `SkillSelection`: the ids, the library
   revision, when, and by whom. Unknown or disabled ids are dropped rather than
   failing the plan.
3. At delivery, Nexora renders the bodies into the **first message** of that
   turn — never into the system prompt. A CLI session's system prompt is fixed
   when the session is created and whether `--resume` applies a changed one is
   not something Nexora can currently verify; a turn's message reaches the model
   on every runtime, fresh or resumed. Every delivery is recorded
   (`skillDeliveries`): scope, agent, skill, revision, bytes, and whether Nexora
   sent it or the agent fetched it.
4. Repairs get a one-line reminder instead of the documents again — unless the
   runtime cannot see the earlier turn (the API runtime is handed only the
   message it is given), in which case the bodies are sent again. Duplicate
   insertion into a conversation that already holds the text does not happen.
5. Anything not selected is still reachable: `list_skills`, `read_skill` and
   `read_skill_reference` are on every Director, Builder and Reviewer turn, so
   an agent that runs into something its selection did not cover can go and get
   the right document itself.

## Revision policy

The library is pinned in source, so it cannot move under a running session. A
selection records the revision it was made from; if the application is
redeployed onto a newer library mid-project, the agent is told in the delivered
block that the document it is reading is not the revision its plan recorded.
Active work is never silently switched to different text.

## Skills grant nothing

`skillsToolServer` is deliberately **not** in `serversForAgent`: no agent gets
skill tools by existing. It is passed explicitly to Director, Builder and
Reviewer turns. Reading a skill adds no permission, no tool, no shell, no
filesystem, no browser, no spending authority and no access to another agent's
credentials. A skill that assumes a capability the session does not have is a
prerequisite to report (or a reason not to select it), never a reason to widen
access. A security or review checklist is guidance about work — it is not, and
must never be presented as, runtime isolation.

## What is in the library

| id | for | ships |
|---|---|---|
| `debugging-and-error-recovery` | build, repair | on |
| `frontend-ui-engineering` | build, repair | on (adapted: the Builder has no browser) |
| `code-review-and-quality` | review | on (adapted: Nexora's verdict contract and review limits win) |
| `test-driven-development` | build, repair | **off** — enabling it would change who is responsible for tests, which is the owner's decision, not an import's |

## Tests

* `node scripts/test-skills.mjs` — catalog, reading, references, permissions,
  isolation, the owner's switch, source integrity, the review contract.
* `node scripts/live-skills.mjs` — one real project on a throwaway git
  repository: what the Director actually chose, what the Builder and Reviewer
  actually received, and what it cost.
