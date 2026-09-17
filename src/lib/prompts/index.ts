/* ------------------------------------------------------------------
   The Prompt Registry, assembled.

   Importing this module registers every built-in prompt (the defs/*
   modules register on load) and gives runtime code the only two calls it
   should ever need:

     getPrompt("task-execution-rule")
     renderPrompt("task-brief", { title, priority, … })

   Adding a prompt anywhere else in the codebase is a defect: see
   docs/prompts.md. A prompt that is not registered cannot be seen,
   edited, exported or reset by the owner, which is the whole point of
   this module existing.
   ------------------------------------------------------------------ */

import "./defs/runtime";
import "./defs/management";
import "./defs/work";
import "./defs/waiting";
import "./defs/capability";
import "./defs/project";
import "./defs/skills";

export {
  registerPrompt,
  promptDefs,
  promptDef,
  isRegistered,
  promptOverride,
  getPrompt,
  getPrompts,
  renderPrompt,
  fill,
  promptView,
  promptViews,
  savePromptOverride,
  resetPrompt,
  promptRevisions,
  restoreRevision,
  PromptError,
} from "./registry";

export * from "./types";
