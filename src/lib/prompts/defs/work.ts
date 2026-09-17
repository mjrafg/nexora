/* ------------------------------------------------------------------
   The messages Nexora itself sends an agent about company work: the
   brief that starts a task, and what whoever is accountable hears when
   the work finishes or stops.

   These are assembled from small pieces on purpose. A line that only
   appears sometimes — a working folder, the list of siblings still out
   with the team — is its own prompt, so editing the main text never
   means reasoning about which lines are present this time.
   ------------------------------------------------------------------ */

import { registerPrompt } from "../registry";

registerPrompt({
  id: "task-brief",
  name: "Task brief",
  description: "What an agent is woken with when work is assigned to it: the outcome wanted, who wants it, and where to take it from here.",
  category: "task",
  version: 1,
  required: true,
  usedBy: ["Any agent given a task"],
  placeholders: ["title", "priority", "assigned_by", "task_id", "folder_block", "description"],
  defaultContent: `[Nexora] You have been assigned a company task.

Task: {{title}}
Priority: {{priority}}
Assigned by: {{assigned_by}}
Task id: {{task_id}}
{{folder_block}}
What is wanted:
{{description}}

Work on it now with the tools you have. When the outcome is achieved call complete_task with a summary of what you actually did and how you verified it. If a capability is missing use request_capability; if a login is missing use the credential tools; if company information is missing use the company tools; if money is needed use the payment tools. Only call block_task when something genuinely outside Nexora stops you.`,
});

registerPrompt({
  id: "task-brief-folder-line",
  name: "Task brief — working folder",
  description: "Added to the brief when the task is pinned to a folder the agent is started inside.",
  category: "task",
  version: 1,
  usedBy: ["Any agent given a task with a folder"],
  placeholders: ["folder"],
  defaultContent: `Working folder: {{folder}} — you are already in it; do this work there.`,
});

registerPrompt({
  id: "task-brief-no-detail",
  name: "Task brief — no detail given",
  description: "Stands in for the description when whoever created the task did not write one.",
  category: "task",
  version: 1,
  usedBy: ["Any agent given a task with no description"],
  defaultContent: `(no further detail was given — use your judgement, and ask only if you truly cannot proceed.)`,
});

/* ---------------------------------------------------------------- delegated work comes back */

registerPrompt({
  id: "delegated-work-finished",
  name: "Delegated work finished",
  description: "Wakes the person holding an objective when a piece they handed out is done, inside that objective's own conversation.",
  category: "management",
  version: 1,
  required: true,
  usedBy: ["Any agent holding a task it delegated out of"],
  placeholders: ["objective_title", "objective_id", "task_title", "task_id", "employee", "result", "detail_block", "tail"],
  // Deliberately dense: this message has had no blank separators since it was
  // written, and the migration into the registry kept it exactly as agents
  // have been receiving it. Add blank lines here if you prefer them.
  defaultContent: `[Nexora] Work you delegated is finished.
Your objective: {{objective_title}} (task {{objective_id}})
Delegated task: {{task_title}} (task {{task_id}})
Done by: {{employee}}
What {{employee}} reported:
{{result}}{{detail_block}}
{{tail}}`,
});

registerPrompt({
  id: "delegated-work-blocked",
  name: "Delegated work blocked",
  description: "Wakes the person holding an objective when a piece they handed out has stopped, and tells them the decision is theirs.",
  category: "management",
  version: 1,
  required: true,
  usedBy: ["Any agent holding a task it delegated out of"],
  placeholders: ["objective_title", "objective_id", "task_title", "task_id", "employee", "reason", "tail"],
  // Dense for the same reason as the "finished" message above.
  defaultContent: `[Nexora] Work you delegated is blocked.
Your objective: {{objective_title}} (task {{objective_id}})
Delegated task: {{task_title}} (task {{task_id}})
Held by: {{employee}}
Why it is blocked:
{{reason}}
{{tail}}
Decide what happens to the blocked piece: a new instruction (update_task), someone better placed (reassign_task), another route, or cancel it and say plainly in your own result what will not be delivered.`,
});

registerPrompt({
  id: "delegated-work-still-out",
  name: "Delegated work — some still out",
  description: "The closing line when other pieces of the objective are still with the team.",
  category: "management",
  version: 1,
  usedBy: ["Any agent holding a task it delegated out of"],
  placeholders: ["count", "list"],
  defaultContent: `Still out with the team ({{count}}): {{list}}. Read this result, decide whether it changes anything, and end your turn — you are woken again as each piece comes back.`,
});

registerPrompt({
  id: "delegated-work-all-back",
  name: "Delegated work — that was the last",
  description: "The closing line when nothing is left outstanding and the objective can be judged.",
  category: "management",
  version: 1,
  usedBy: ["Any agent holding a task it delegated out of"],
  defaultContent: `That was the last of the delegated work. Read the results, judge whether the objective is actually met, and either complete your own task with a summary that references what your team produced, or delegate what is genuinely still missing.`,
});

/* ---------------------------------------------------------------- reported to the accountable manager */

registerPrompt({
  id: "task-finished-manager-report",
  name: "Task finished — told to the manager",
  description: "What the manager accountable for a task hears when it is completed, in the conversation the work was asked for in.",
  category: "management",
  version: 1,
  required: true,
  usedBy: ["The manager accountable for a task"],
  placeholders: ["title", "employee", "task_id", "result", "detail_block"],
  defaultContent: `[Nexora] A task you are accountable for is finished.

Task: {{title}}
Done by: {{employee}}
Task id: {{task_id}}

What {{employee}} reported:
{{result}}{{detail_block}}

Read it and decide whether anything follows from it. Create a follow-up task only if real work remains — do not invent one. If the result answers the owner's request, say so plainly the next time you speak to them.`,
});

registerPrompt({
  id: "task-blocked-manager-report",
  name: "Task blocked — told to the manager",
  description: "What the manager accountable for a task hears when it stops, with the history so far and the decision to make.",
  category: "management",
  version: 1,
  required: true,
  usedBy: ["The manager accountable for a task"],
  placeholders: ["title", "employee", "task_id", "reason", "history"],
  defaultContent: `[Nexora] A task you are accountable for is blocked.

Task: {{title}}
Assigned to: {{employee}}
Task id: {{task_id}}

Why it is blocked:
{{reason}}

What has happened so far:
{{history}}

Decide what happens next: give {{employee}} a new instruction (update_task), move the work to someone better placed (reassign_task), take a different route, cancel it, or bring it to the owner if only they can unblock it. Do not simply wait.`,
});

registerPrompt({
  id: "several-updates-at-once",
  name: "Several updates at once",
  description: "The header when results that arrived together are merged into one wake-up, so nothing is read in isolation.",
  category: "management",
  version: 1,
  usedBy: ["Any agent woken by more than one result at once"],
  placeholders: ["count"],
  defaultContent: `[Nexora] {{count}} updates arrived on work you are accountable for. Read all of them before you decide anything.`,
});
