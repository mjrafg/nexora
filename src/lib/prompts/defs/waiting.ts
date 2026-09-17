/* ------------------------------------------------------------------
   What an agent is told when the thing it was parked on is settled.

   Every one of these ends a wait, so each has to do two jobs: say what
   the owner decided, and say what to do about it. A resume that only
   reports the decision leaves the agent guessing.
   ------------------------------------------------------------------ */

import { registerPrompt } from "../registry";

/* ---------------------------------------------------------------- credentials */

registerPrompt({
  id: "credential-resolved-resume",
  name: "Login supplied — resume",
  description: "Sent when the owner adds the login an agent asked for.",
  category: "credentials",
  version: 1,
  required: true,
  usedBy: ["Any agent waiting for a login"],
  placeholders: ["short_id", "service", "site", "credential_name", "credential_service", "credential_site"],
  defaultContent: `[Nexora] Your credential request #{{short_id}} for {{service}} ({{site}}) is RESOLVED: the owner added "{{credential_name}}" ({{credential_service}}, {{credential_site}}). Call list_credentials, pick it, insert the fields with insert_credential_field / insert_credentials on the login page, and continue the work you were doing. Never read inserted values back.`,
});

registerPrompt({
  id: "credential-dismissed-resume",
  name: "Login refused — resume",
  description: "Sent when the owner dismisses a credential request, so the agent is never left waiting for a login that is not coming.",
  category: "credentials",
  version: 1,
  required: true,
  usedBy: ["Any agent waiting for a login"],
  placeholders: ["short_id", "service", "site"],
  defaultContent: `[Nexora] Your credential request #{{short_id}} for {{service}} ({{site}}) was DISMISSED by the owner — no login will be supplied for it. Do not ask for the same one again. If you can create the account yourself, do that; otherwise find another route, and if there is none, report honestly what is blocked and why.`,
});

/* ---------------------------------------------------------------- company information */

registerPrompt({
  id: "company-info-resolved-resume",
  name: "Company information supplied — resume",
  description: "Sent when the owner fills in the company value an agent asked for.",
  category: "company",
  version: 1,
  required: true,
  usedBy: ["Any agent waiting for company information"],
  placeholders: ["short_id", "label", "needed_by"],
  defaultContent: `[Nexora] Your company information request #{{short_id}} is RESOLVED: the owner filled in "{{label}}" in the Company Profile. Call get_company_profile to read the current values, then continue the work you were doing ({{needed_by}}). Never invent company information.`,
});

registerPrompt({
  id: "company-info-dismissed-resume",
  name: "Company information refused — resume",
  description: "Sent when the owner dismisses a company information request: the value is not coming, and it must not be invented.",
  category: "company",
  version: 1,
  required: true,
  usedBy: ["Any agent waiting for company information"],
  placeholders: ["short_id", "label"],
  defaultContent: `[Nexora] Your company information request #{{short_id}} for "{{label}}" was DISMISSED by the owner — that value is not going to be supplied. Do NOT invent it and do not ask for it again. Carry on with everything the task still allows without it; if the outcome genuinely cannot be reached, say exactly which value is missing and why it stops you.`,
});

/* ---------------------------------------------------------------- payments */

registerPrompt({
  id: "payment-approved-resume",
  name: "Payment approved — resume",
  description: "Sent when the owner approves a payment: which method to use and how to complete the checkout exactly once.",
  category: "payments",
  version: 1,
  required: true,
  usedBy: ["Any agent waiting for a payment decision"],
  placeholders: ["short_id", "merchant", "amount", "billing", "note", "via", "request_id"],
  defaultContent: `[Nexora] Payment request #{{short_id}} for {{merchant}} ({{amount}}{{billing}}) was APPROVED by the owner{{note}}. Payment method: {{via}}. You have 30 minutes: go to the checkout in the browser, take a snapshot, call insert_payment_method_fields with payment_request_id "{{request_id}}" mapping the payment fields to their element refs (Nexora types the values; never read them back), submit once, verify the result, then call complete_payment. Continue the work you were doing.`,
});

registerPrompt({
  id: "payment-rejected-resume",
  name: "Payment rejected — resume",
  description: "Sent when the owner refuses a payment: nothing is released and the same request must not be made again.",
  category: "payments",
  version: 1,
  required: true,
  usedBy: ["Any agent waiting for a payment decision"],
  placeholders: ["short_id", "merchant", "amount", "note"],
  defaultContent: `[Nexora] Payment request #{{short_id}} for {{merchant}} ({{amount}}) was REJECTED by the owner{{note}}. No payment details will be released. Look for a free alternative or report honestly what is blocked; do not request this payment again unless something changed.`,
});

registerPrompt({
  id: "payment-cancelled-resume",
  name: "Payment cancelled — resume",
  description: "Sent when a payment request is called off, so the agent stops waiting on an authorization that no longer exists.",
  category: "payments",
  version: 1,
  required: true,
  usedBy: ["Any agent waiting for a payment decision"],
  placeholders: ["short_id", "merchant", "amount", "by", "note"],
  defaultContent: `[Nexora] Payment request #{{short_id}} for {{merchant}} ({{amount}}) was CANCELLED by {{by}}{{note}}. No authorization exists and no payment details will be released. Do not request the same payment again unless something has genuinely changed: look for a free alternative, or report honestly what is blocked.`,
});

/* ---------------------------------------------------------------- browser handoff */

registerPrompt({
  id: "browser-returned-resume",
  name: "Browser returned — resume",
  description: "Sent when the owner finishes the human-only step and hands the live browser back.",
  category: "browser",
  version: 1,
  required: true,
  usedBy: ["Any agent that handed its browser to the owner"],
  placeholders: ["short_id", "reason", "note"],
  defaultContent: `[Nexora] The owner finished in your browser and returned control to you (handoff #{{short_id}}: {{reason}}){{note}}. It is the same browser session: same tabs, cookies and page. Call browser_snapshot first to see the page as it is now, then continue the work you were doing. Do not start over and do not open a new browser.`,
});

registerPrompt({
  id: "browser-cancelled-resume",
  name: "Browser handed back unfinished — resume",
  description: "Sent when the owner closes a browser handoff without completing the step.",
  category: "browser",
  version: 1,
  required: true,
  usedBy: ["Any agent that handed its browser to the owner"],
  placeholders: ["short_id", "reason", "note"],
  defaultContent: `[Nexora] The owner closed the browser handoff #{{short_id}} ({{reason}}) without completing it{{note}}. You have control of the browser again. Check the page with browser_snapshot: if the step is still blocked, find another way or report honestly what is blocked.`,
});

/* ---------------------------------------------------------------- owner actions */

registerPrompt({
  id: "owner-action-resume",
  name: "Owner answered — resume",
  description: "The wrapper around every answer from Needs You: the decision, and the instruction to pick the same work up where it stopped.",
  category: "runtime",
  version: 1,
  required: true,
  usedBy: ["Any agent waiting on Needs You"],
  placeholders: ["title", "summary", "scope_note"],
  defaultContent: `[Nexora] {{title}} — resolved by the owner. {{summary}}

This is the same task you were on ({{scope_note}}): continue from where you stopped, re-check anything outside Nexora that may have changed while you waited, and do not repeat work you already finished.`,
});

registerPrompt({
  id: "owner-action-dismissed",
  name: "Owner dismissed the request",
  description: "What an agent is told when the owner dismisses what it asked for in Needs You.",
  category: "runtime",
  version: 1,
  required: true,
  usedBy: ["Any agent waiting on Needs You"],
  placeholders: ["note"],
  defaultContent: `The owner dismissed this request{{note}}. Do not ask again for the same thing: continue with what you can do, or report honestly what is blocked.`,
});

registerPrompt({
  id: "owner-action-data-provided",
  name: "Owner supplied values",
  description: "How values the owner typed into a Needs You form are handed to the agent.",
  category: "runtime",
  version: 1,
  usedBy: ["Any agent that asked the owner for information"],
  placeholders: ["values"],
  defaultContent: `The owner provided:
{{values}}
Use these values now and continue the task.`,
});

registerPrompt({
  id: "owner-action-data-empty",
  name: "Owner supplied nothing",
  description: "Used when the owner submits the form without filling anything in.",
  category: "runtime",
  version: 1,
  usedBy: ["Any agent that asked the owner for information"],
  defaultContent: `The owner submitted the form without values. Continue with what you can do.`,
});

registerPrompt({
  id: "owner-action-turns-granted",
  name: "More steps granted",
  description: "Sent when the owner lets a long task keep going.",
  category: "runtime",
  version: 1,
  usedBy: ["Any agent that ran out of steps"],
  placeholders: ["grant"],
  defaultContent: `The owner approved {{grant}}. Continue exactly where you stopped — do not start over.`,
});

registerPrompt({
  id: "owner-action-turns-stopped",
  name: "Task stopped by the owner",
  description: "Sent when the owner ends a long task instead of extending it.",
  category: "runtime",
  version: 1,
  usedBy: ["Any agent that ran out of steps"],
  defaultContent: `The owner stopped this task. Summarise what you completed and what remains, then stop.`,
});

registerPrompt({
  id: "owner-action-browser-finished",
  name: "Owner finished in the browser",
  description: "Sent when a CAPTCHA or other human-only browser step is done.",
  category: "browser",
  version: 1,
  usedBy: ["Any agent that handed its browser to the owner"],
  defaultContent: `The owner finished in the browser. Call browser_snapshot first to see the page as it is now, then continue in the same session.`,
});

registerPrompt({
  id: "owner-action-decision",
  name: "Owner made a decision",
  description: "The general answer for any other kind of request the owner responds to.",
  category: "runtime",
  version: 1,
  usedBy: ["Any agent waiting on Needs You"],
  placeholders: ["choice", "note"],
  defaultContent: `{{choice}}{{note}} Continue the task with that decision.`,
});
