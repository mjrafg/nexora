/* ------------------------------------------------------------------
   request_owner_action — the one way an agent asks a human for
   something.

   It is deliberately typed rather than free text: the kind decides what
   the owner is shown (a form, an approve/decline, the live browser, a
   turn-budget decision), and every request carries a reason, the task it
   belongs to and, where one exists, the record it stands for.

   It is also expensive: it spends the owner's attention. The autonomy
   rule in every agent's prompt says to exhaust context, company data,
   authorized resources, tools, defaults and provisional values first.
   ------------------------------------------------------------------ */

import type { AgentRecord } from "@/lib/runtime/types";
import { registerToolServer, type InternalToolDef, type InternalToolResult, type InternalToolServer } from "@/lib/tools/internal";
import { createOwnerAction } from "./service";
import type { OwnerActionKind, OwnerField, OwnerFieldType } from "./types";

const ok = (text: string): InternalToolResult => ({ ok: true, text });
const fail = (text: string): InternalToolResult => ({ ok: false, text });
const s = (v: unknown, max = 1_000) => (typeof v === "string" ? v.slice(0, max).trim() : "");

const KINDS: OwnerActionKind[] = ["data", "approval", "decision", "browser", "captcha", "otp", "signature", "turn_budget", "other"];
const FIELD_TYPES: OwnerFieldType[] = ["text", "textarea", "number", "date", "boolean", "email", "phone", "url", "select", "multi_select", "json"];

const TOOL: InternalToolDef = {
  name: "request_owner_action",
  sideEffect: "SIDE_EFFECT",
  description:
    "Ask the owner for something that only a human can give. It appears in Needs You, notifies them, and (when blocking) parks this task until they answer — then you are resumed automatically where you stopped.\n" +
    "LAST RESORT. First use the task context, get_company_profile, get_company_custom_data, the credentials and resources you already have, your own tools, a safe reversible default, or a provisional value you record with record_assumption. Never ask for optional fields, preferences or anything Nexora already stores.\n" +
    'kind "data": you need real values — list every one you are missing in `fields` so the owner answers once, not three times.\n' +
    'kind "approval" / "decision": the owner must choose; give `choices`.\n' +
    'kind "captcha" / "browser" / "otp": a human step in YOUR live browser — the owner gets your exact page, does that step and hands control back. Never use a credential or capability request for this.\n' +
    'kind "signature" / "other": anything else only a person may do.\n' +
    "Set blocking false when you can carry on with other parts of the task meanwhile.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: KINDS },
      title: { type: "string", description: "one line the owner sees first, e.g. \"Date of birth required\"" },
      reason: { type: "string", description: "why you cannot continue without them, and what you already tried" },
      blocking: { type: "boolean", description: "default true; false means you keep working meanwhile" },
      fields: {
        type: "array",
        description: 'kind "data": every value you are missing, asked for together',
        items: {
          type: "object",
          properties: {
            key: { type: "string", description: "where it belongs if kept: a company profile field or a dot-namespaced company data key, e.g. signup.default_birth_date" },
            label: { type: "string" },
            type: { type: "string", enum: FIELD_TYPES },
            required: { type: "boolean" },
            help: { type: "string" },
            options: { type: "array", items: { type: "string" }, description: "for select / multi_select" },
            save_for_future: { type: "boolean", description: "offer to keep it for later tasks (default true; false for one-off or sensitive answers)" },
          },
          required: ["key", "label", "type"],
        },
      },
      choices: {
        type: "array",
        description: 'kind "approval" / "decision": what the owner can pick',
        items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" }, style: { type: "string", enum: ["primary", "danger", "ghost"] }, note: { type: "string" } }, required: ["value", "label"] },
      },
      details: {
        type: "array",
        description: "non-secret facts shown with the action, e.g. amount, merchant, current page",
        items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] },
      },
    },
    required: ["kind", "title", "reason"],
  },
};

export function ownerActionToolsFor(agent: AgentRecord): InternalToolDef[] {
  void agent;
  return [TOOL];
}

export const ownerActionToolServer: InternalToolServer = registerToolServer({
  slug: "owner",
  name: "Owner",
  tools: [TOOL],
  call: async (name, args, ctx) => {
    if (name !== TOOL.name) return fail(`Unknown tool ${name}`);
    try {
      const kind = (KINDS.includes(s(args.kind, 20) as OwnerActionKind) ? s(args.kind, 20) : "other") as OwnerActionKind;
      const title = s(args.title, 160);
      const reason = s(args.reason, 1_000);
      if (!title) return fail("title is required.");
      if (!reason) return fail("reason is required: say why you cannot continue and what you already tried.");
      const blocking = args.blocking !== false;

      const fields: OwnerField[] = Array.isArray(args.fields)
        ? (args.fields as Record<string, unknown>[]).map((f) => ({
            key: s(f.key, 120).toLowerCase().replace(/\s+/g, "_"),
            label: s(f.label, 120) || s(f.key, 120),
            type: (FIELD_TYPES.includes(s(f.type, 20) as OwnerFieldType) ? s(f.type, 20) : "text") as OwnerFieldType,
            required: f.required !== false,
            help: s(f.help, 300) || undefined,
            options: Array.isArray(f.options) ? (f.options as unknown[]).map((o) => s(o, 80)).filter(Boolean).slice(0, 40) : undefined,
            saveForFuture: f.save_for_future !== false,
          })).filter((f) => f.key && f.label).slice(0, 12)
        : [];
      if (kind === "data" && !fields.length) return fail('kind "data" needs at least one field: list every value you are missing so the owner answers once.');

      const choices = Array.isArray(args.choices)
        ? (args.choices as Record<string, unknown>[]).map((c) => ({ value: s(c.value, 60), label: s(c.label, 80), style: (["primary", "danger", "ghost"].includes(s(c.style, 20)) ? s(c.style, 20) : undefined) as "primary" | "danger" | "ghost" | undefined, note: s(c.note, 200) || undefined })).filter((c) => c.value && c.label).slice(0, 6)
        : [];
      const details = Array.isArray(args.details)
        ? (args.details as Record<string, unknown>[]).map((d) => ({ label: s(d.label, 60), value: s(d.value, 400) })).filter((d) => d.label && d.value).slice(0, 12)
        : [];

      const browserKind = kind === "captcha" || kind === "browser" || kind === "otp";
      if (browserKind) {
        // a human step in the page is a real handoff of the agent's own session
        const { createHandoff } = await import("@/lib/browser/handoff");
        const h = createHandoff({ agentId: ctx.agentId, mode: blocking ? "INTERACTIVE" : "VIEW", reason: `${title} — ${reason}`.slice(0, 480), executionScopeId: ctx.scopeId });
        return ok(
          blocking
            ? `The owner now has your live browser (handoff ${h.id.slice(0, 8)}) and it is at the top of Needs You. Do not touch the browser. END YOUR TURN — when they hand control back you are resumed, and your first step then is browser_snapshot.`
            : `Your browser is now visible to the owner in Needs You (handoff ${h.id.slice(0, 8)}). Keep working.`,
        );
      }

      const { agentBrowserKey } = await import("@/lib/browser");
      const action = await createOwnerAction({
        agentId: ctx.agentId, kind, title, reason, blocking,
        taskId: ctx.scopeId, sessionId: kind === "signature" ? agentBrowserKey(ctx.agentId) : undefined,
        payload: { fields: fields.length ? fields : undefined, choices: choices.length ? choices : undefined, details: details.length ? details : undefined },
      });
      return ok(
        blocking
          ? `Asked the owner: "${action.title}" (#${action.id.slice(0, 8)}). It is in Needs You and they have been notified. END YOUR TURN now — you are resumed automatically with their answer, in this same task.`
          : `Asked the owner: "${action.title}" (#${action.id.slice(0, 8)}). It is in Needs You. You are not blocked — carry on with the rest of the task.`,
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});
