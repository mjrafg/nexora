/* ------------------------------------------------------------------
   Company Profile tool server ("company") — read-only for agents.

   read (permission company_profile):
     get_company_profile   the canonical company record (absent fields
                           are simply absent — never invented)
     get_company_info      the same data narrowed to the fields asked for
     request_company_info  a genuinely missing value: the owner fills it
                           in the UI and the agent resumes automatically

   custom data (read with company_profile, write with
   company_custom_data_manage): get_company_custom_data /
   upsert_company_custom_data — operational defaults and reusable
   answers so an agent does not have to stop and ask. Never secrets.

   write (permission company_profile_manage) — explicitly authorized
   agents only, every call audited with the agent and its reason:
     update_company_profile / add_company_contact / update_company_contact

   Agent writes can only add or correct: an empty value is ignored, an
   address is merged rather than replaced, and nothing can be deleted —
   removing a contact or clearing a field stays with the owner.
   ------------------------------------------------------------------ */

import { readDb } from "@/lib/store/db";
import type { AgentRecord } from "@/lib/runtime/types";
import { registerToolServer, type InternalToolDef, type InternalToolResult, type InternalToolServer } from "@/lib/tools/internal";
import { addContact, addCompanyActivity, FIELDS, findField, formatAddress, getProfile, hasAddress, ownerName, resolvedBilling, updateContact, updateProfile } from "./store";
import { createCompanyInfoRequest, resolveFilledRequests } from "./service";
import type { Actor, Address, CompanyProfile } from "./types";

const ok = (text: string): InternalToolResult => ({ ok: true, text });
const fail = (text: string): InternalToolResult => ({ ok: false, text });
const s = (v: unknown, max = 1_000) => (typeof v === "string" ? v.slice(0, max).trim() : "");

export const COMPANY_PERMISSION = "company_profile";
export const COMPANY_MANAGE_PERMISSION = "company_profile_manage";
export const CUSTOM_DATA_MANAGE_PERMISSION = "company_custom_data_manage";

const addressOut = (a?: Address) => (hasAddress(a) ? { line1: a!.line1, line2: a!.line2, city: a!.city, state: a!.region, postal_code: a!.postalCode, country: a!.country, formatted: formatAddress(a) } : undefined);

/** Canonical JSON for the model: only fields that actually have a value. */
export function profilePayload(p: CompanyProfile): Record<string, unknown> {
  const contacts = p.contacts.filter((c) => c.status === "ACTIVE").map((c) => ({ type: c.type, name: c.name, value: c.value, description: c.description, is_primary: c.isPrimary }));
  const legal = {
    entity_type: p.legal.entityType ?? p.entityType,
    registration_state: p.legal.registrationState,
    registration_country: p.legal.registrationCountry,
    formation_date: p.legal.formationDate,
    tax_id: p.legal.taxId,
    registration_number: p.legal.registrationNumber,
    registered_address: addressOut(p.legal.registeredAddress),
  };
  const out: Record<string, unknown> = {
    name: p.name || undefined,
    legal_name: p.legalName,
    entity_type: p.entityType,
    industry: p.industry,
    website: p.website,
    description: p.description,
    timezone: p.timezone,
    owner: p.ownerFirstName || p.ownerLastName ? prune({ first_name: p.ownerFirstName, last_name: p.ownerLastName, full_name: ownerName(p), title: p.ownerTitle }) : undefined,
    contacts: contacts.length ? contacts : undefined,
    address: addressOut(p.address),
    billing_address: addressOut(resolvedBilling(p)),
    billing_address_same_as_company: p.billingSameAsCompany || undefined,
    legal: Object.values(legal).some(Boolean) ? prune(legal) : undefined,
  };
  return prune(out);
}

function prune<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length))) as T;
}

/** Which canonical fields are still empty — told to the agent so it asks instead of inventing. */
function missingFields(p: CompanyProfile): string[] {
  return FIELDS.filter((f) => !f.get(p)).map((f) => f.key);
}

const FIELD_KEYS = FIELDS.map((f) => f.key).join(", ");

const TOOLS: InternalToolDef[] = [
  {
    name: "get_company_profile",
    description: `Nexora's canonical company information — the source of truth for every form, signup, vendor or account that asks about the company: name, legal name, entity type, industry, website, timezone, contact methods (each with a description of what it is for), company address, billing address and legal/registration data. Fields the owner has not provided are absent and listed under "missing" — never invent or guess them. When several contacts exist, pick the one whose name and description fit the task.`,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_company_info",
    description: `The same canonical company data, narrowed to the fields you need. fields: ${FIELD_KEYS}. Also accepts "contacts". Missing values are reported as missing, never guessed.`,
    inputSchema: { type: "object", properties: { fields: { type: "array", items: { type: "string" }, description: `e.g. ["name","website","primary_email","primary_phone","billing_address"]` } }, required: ["fields"] },
  },
  {
    name: "request_company_info",
    sideEffect: "SIDE_EFFECT",
    description: `A form genuinely requires a company value that is NOT in the Company Profile: ask the owner for that one field instead of inventing it. Use a canonical field key when one fits (${FIELD_KEYS}), otherwise describe the field. Finish everything else you can first, then call this and END YOUR TURN — the owner fills it in the Company Profile and you are resumed automatically.`,
    inputSchema: { type: "object", properties: { field: { type: "string", description: "canonical field key, or a short name of the value needed" }, needed_by: { type: "string", description: "what needs it, e.g. \"Google Ads account signup\"" }, reason: { type: "string", description: "why it is required to continue" } }, required: ["field", "needed_by"] },
  },
];

const CUSTOM_DATA_READ: InternalToolDef[] = [
  {
    name: "get_company_custom_data",
    description:
      "The company's reusable operational data: signup defaults, vendor identifiers, preferences, codes — anything the owner or another agent has already answered once. ALWAYS look here before asking the owner for a value that is not part of the canonical profile. Call with no arguments for everything, `keys` for exact lookups, `namespace` for a family (e.g. \"signup\"), or `search` for free text. Each entry says whether it is verified (the owner stands behind it) or provisional (an agent chose it and it may be corrected). It never contains passwords, API keys or card numbers.",
    inputSchema: {
      type: "object",
      properties: {
        keys: { type: "array", items: { type: "string" }, description: 'exact keys, e.g. ["signup.default_country","signup.default_birth_date"]' },
        namespace: { type: "string", description: 'everything under one prefix, e.g. "signup"' },
        search: { type: "string", description: "free text over key, value and description" },
      },
    },
  },
];

const CUSTOM_DATA_WRITE: InternalToolDef[] = [
  {
    name: "upsert_company_custom_data",
    sideEffect: "SIDE_EFFECT",
    // if the agent passes something it should not (a card number, a key), the
    // refusal must not be the thing that writes it into the audit trail
    maskArgs: ["value"],
    description:
      "Save a reusable non-secret company value so nobody has to work it out again: a default you chose, a preference, an identifier a vendor gave you. Use a lowercase dot-namespaced key (signup.default_country, google.preferred_username_prefix, operations.warehouse_code) and give a reason. Anything you save is recorded as PROVISIONAL — only the owner can mark a value verified — so save your assumption and keep working rather than stopping to ask. Never put a password, API key, token or card number here: those belong in save_credential, an MCP credential or save_payment_method.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "lowercase, dot-namespaced, e.g. signup.default_country" },
        value: { type: "string" },
        value_type: { type: "string", enum: ["string", "number", "boolean", "date", "url", "email", "phone", "json"] },
        label: { type: "string", description: "optional short human label" },
        description: { type: "string", description: "what this value is for, so the next agent understands it" },
        reason: { type: "string", description: "why you chose it — shown to the owner with the assumption" },
      },
      required: ["key", "value", "reason"],
    },
  },
];

const WRITE_TOOLS: InternalToolDef[] = [
  {
    name: "update_company_profile",
    sideEffect: "SIDE_EFFECT",
    description: `Correct or fill in canonical company information — only when you have verified it (the owner told you, or it comes from an authoritative source such as the company's own registration document or account). Pass only the fields you are changing; everything else is left alone. Address fields are merged into the existing address, an empty value is ignored, and nothing can be deleted — ask the owner for that. Every change is recorded with your name and your reason. Never write a value you inferred, assumed or found on a random website, and never "correct" the profile to match what some external service displays.`,
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "why this change is correct and where the value came from — recorded for the owner" },
        name: { type: "string" }, legal_name: { type: "string" }, entity_type: { type: "string" }, industry: { type: "string" }, website: { type: "string" }, description: { type: "string" }, timezone: { type: "string", description: "IANA name, e.g. America/New_York" },
        owner_first_name: { type: "string" }, owner_last_name: { type: "string" }, owner_title: { type: "string", description: "e.g. Owner, Founder, Managing Member" },
        address: { type: "object", description: "{ line1, line2, city, state, postal_code, country } — merged into the current address" },
        billing_address: { type: "object", description: "same shape; sets a billing address that differs from the company address" },
        billing_same_as_company: { type: "boolean" },
        legal: { type: "object", description: "{ entity_type, registration_state, registration_country, formation_date (YYYY-MM-DD), tax_id, registration_number, registered_address }" },
      },
      required: ["reason"],
    },
  },
  {
    name: "add_company_contact",
    sideEffect: "SIDE_EFFECT",
    description: `Save a new company email address or phone number (for example a mailbox you just created for the company). The description must tell other agents when to use it and when not to — that is how they choose between contacts. Set is_primary only when this genuinely becomes the company's main address or number for its type.`,
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["EMAIL", "PHONE"] }, name: { type: "string", description: "short label, e.g. \"Billing Email\"" }, value: { type: "string" },
        description: { type: "string", description: "what this contact is for (at least 10 characters)" }, is_primary: { type: "boolean" }, reason: { type: "string" },
      },
      required: ["type", "name", "value", "description", "reason"],
    },
  },
  {
    name: "update_company_contact",
    sideEffect: "SIDE_EFFECT",
    description: `Change a saved company contact: its label, value, purpose description, primary flag, or status (ACTIVE / INACTIVE — use INACTIVE for a contact that is no longer in service; deleting is the owner's decision).`,
    inputSchema: {
      type: "object",
      properties: { contact_id: { type: "string" }, name: { type: "string" }, value: { type: "string" }, description: { type: "string" }, is_primary: { type: "boolean" }, status: { type: "string", enum: ["ACTIVE", "INACTIVE"] }, reason: { type: "string" } },
      required: ["contact_id", "reason"],
    },
  },
];

export function companyToolsFor(agent: AgentRecord): InternalToolDef[] {
  const p = agent.toolPermissions;
  const reads = p.includes(COMPANY_PERMISSION) || p.includes(COMPANY_MANAGE_PERMISSION) || p.includes(CUSTOM_DATA_MANAGE_PERMISSION) || agent.system === "capability-manager";
  return [
    ...(reads ? [...TOOLS, ...CUSTOM_DATA_READ] : []),
    ...(p.includes(COMPANY_MANAGE_PERMISSION) ? WRITE_TOOLS : []),
    ...(p.includes(CUSTOM_DATA_MANAGE_PERMISSION) ? CUSTOM_DATA_WRITE : []),
  ];
}

/** one activity line per agent per minute — the profile is read often */
const lastRead = new Map<string, number>();
function noteRead(agentId: string, what: string) {
  const prev = lastRead.get(agentId) ?? 0;
  if (Date.now() - prev < 60_000) return;
  lastRead.set(agentId, Date.now());
  const name = readDb().agents.find((a) => a.id === agentId)?.name ?? agentId.slice(0, 8);
  addCompanyActivity("read", `Company information requested by ${name} (${what})`, { agentId });
}

export const companyToolServer: InternalToolServer = registerToolServer({
  slug: "company",
  name: "Company Profile",
  tools: TOOLS,
  toolsFor: (agent) => companyToolsFor(agent as AgentRecord),
  call: async (name, args, ctx) => {
    try {
      const agent = readDb().agents.find((a) => a.id === ctx.agentId);
      if (!agent) return fail("Agent not found.");
      if (WRITE_TOOLS.some((t) => t.name === name) && !agent.toolPermissions.includes(COMPANY_MANAGE_PERMISSION)) {
        return fail("This agent may read the company profile but not change it (permission Company profile: update). Use request_company_info to ask the owner.");
      }
      if (CUSTOM_DATA_WRITE.some((t) => t.name === name) && !agent.toolPermissions.includes(CUSTOM_DATA_MANAGE_PERMISSION)) {
        return fail("This agent may read company data but not save it (permission Company data: save).");
      }
      const by: Actor = { kind: "agent", id: agent.id, name: agent.name, reason: s(args.reason, 300) || undefined };
      const profile = getProfile();
      switch (name) {
        case "get_company_profile": {
          const payload = profilePayload(profile);
          if (!Object.keys(payload).length) return ok("The Company Profile is empty — the owner has not entered any company information yet. Do not invent company details: call request_company_info for the specific value you need.");
          noteRead(ctx.agentId, "full profile");
          const missing = missingFields(profile);
          return ok(JSON.stringify({ ...payload, missing, note: "Authoritative company data. Never invent a value that is missing — request_company_info asks the owner for it." }, null, 1));
        }
        case "get_company_info": {
          const wanted = Array.isArray(args.fields) ? args.fields.map((f) => s(f, 60)).filter(Boolean) : [];
          if (!wanted.length) return fail(`fields is required, e.g. ["name","website","primary_email"]. Known fields: ${FIELD_KEYS}.`);
          const payload = profilePayload(profile);
          const out: Record<string, unknown> = {};
          const missing: string[] = [];
          const unknown: string[] = [];
          for (const raw of wanted) {
            const key = raw.toLowerCase().replace(/\s+/g, "_");
            if (key === "contacts") { if (payload.contacts) out.contacts = payload.contacts; else missing.push("contacts"); continue; }
            const field = findField(key);
            if (!field) { unknown.push(raw); continue; }
            const value = field.get(profile);
            if (!value) { missing.push(field.key); continue; }
            if (key.startsWith("legal.")) out[field.key] = value;
            else if (key === "address") out.address = payload.address;
            else if (key === "billing_address") out.billing_address = payload.billing_address;
            else out[field.key] = value;
          }
          noteRead(ctx.agentId, wanted.join(", ").slice(0, 60));
          return ok(JSON.stringify({ ...out, ...(missing.length ? { missing } : {}), ...(unknown.length ? { unknown_fields: unknown, known_fields: FIELDS.map((f) => f.key) } : {}), ...(missing.length ? { note: "Missing values are not available — do not invent them; use request_company_info if one is truly required." } : {}) }, null, 1));
        }
        case "request_company_info": {
          const field = s(args.field, 80);
          if (!field) return fail("field is required.");
          const known = findField(field);
          if (known && known.get(profile)) return fail(`"${known.label}" is already in the Company Profile — call get_company_profile and use that value.`);
          const { currentRequestId } = await import("@/lib/capabilities/manager");
          const capId = ctx.agentId === "capability-manager" ? currentRequestId() ?? undefined : undefined;
          const r = createCompanyInfoRequest({ agentId: ctx.agentId, field, neededBy: s(args.needed_by, 160) || "(not stated)", reason: s(args.reason, 1_000), executionScopeId: ctx.scopeId, capabilityRequestId: capId });
          if (capId) { const { onCompanyInfoRequested } = await import("@/lib/capabilities/manager"); await onCompanyInfoRequested(capId, r); }
          return ok(`Company information request #${r.id.slice(0, 8)} ("${r.label}") sent to the owner (Company Profile page). Do not invent the value. Finish anything else you can, end your turn, and you will be resumed automatically once it is filled in.`);
        }
        case "get_company_custom_data": {
          const { searchCustomData, toCustomDataPayload } = await import("./custom-data");
          const keys = Array.isArray(args.keys) ? args.keys.map((k) => s(k, 120)).filter(Boolean) : undefined;
          const rows = searchCustomData({ keys, namespace: s(args.namespace, 60) || undefined, search: s(args.search, 120) || undefined });
          if (!rows.length) {
            const total = (await import("./custom-data")).listCustomData().length;
            return ok(keys?.length
              ? JSON.stringify({ found: [], missing: keys, note: "Not stored. Decide it yourself if the choice is safe and reversible (then save it with upsert_company_custom_data and report the assumption); only ask the owner if the value must be authoritative." }, null, 1)
              : `No company data matches${total ? "" : " (none has been saved yet)"}.`);
          }
          noteRead(ctx.agentId, keys?.length ? keys.join(", ").slice(0, 60) : s(args.namespace, 60) || "custom data");
          const found = toCustomDataPayload(rows);
          const missing = keys?.filter((k) => !rows.some((r) => r.key === k.toLowerCase())) ?? [];
          return ok(JSON.stringify({ found, ...(missing.length ? { missing } : {}) }, null, 1));
        }
        case "upsert_company_custom_data": {
          const { SecretRejected, upsertCustomDatum } = await import("./custom-data");
          const reason = s(args.reason, 400);
          if (!reason) return fail("reason is required: say why you chose this value.");
          try {
            const d = upsertCustomDatum(
              { key: s(args.key, 120), value: s(args.value, 4_000), valueType: s(args.value_type, 20) as never, label: s(args.label, 120) || undefined, description: s(args.description, 600) || undefined, reason },
              { kind: "agent", id: agent.id, name: agent.name },
            );
            const { recordAssumption } = await import("@/lib/agents/assumptions");
            recordAssumption({ agentId: ctx.agentId, summary: `Stored ${d.key} = ${d.value}`, detail: reason, customDataKey: d.key, scopeId: ctx.scopeId });
            return ok(JSON.stringify({ success: true, key: d.key, value: d.value, status: d.status, note: "Saved as provisional and recorded as an assumption. Keep going; the owner can correct it afterwards." }));
          } catch (err) {
            if (err instanceof SecretRejected) return fail(err.message);
            throw err;
          }
        }
        case "update_company_profile": {
          const reason = s(args.reason, 300);
          if (!reason) return fail("reason is required: say why this value is correct and where it came from.");
          const legalIn = (args.legal && typeof args.legal === "object" ? args.legal : {}) as Record<string, unknown>;
          const patch = {
            name: s(args.name, 120) || undefined,
            legalName: s(args.legal_name, 160) || undefined,
            entityType: s(args.entity_type, 60) || undefined,
            industry: s(args.industry, 120) || undefined,
            website: s(args.website, 300) || undefined,
            description: s(args.description, 600) || undefined,
            timezone: s(args.timezone, 60) || undefined,
            ownerFirstName: s(args.owner_first_name, 80) || undefined,
            ownerLastName: s(args.owner_last_name, 80) || undefined,
            ownerTitle: s(args.owner_title, 80) || undefined,
            address: args.address && typeof args.address === "object" ? args.address : undefined,
            billingAddress: args.billing_address && typeof args.billing_address === "object" ? args.billing_address : undefined,
            billingSameAsCompany: typeof args.billing_same_as_company === "boolean" ? args.billing_same_as_company : undefined,
            legal: Object.keys(legalIn).length ? {
              entityType: s(legalIn.entity_type, 60) || undefined,
              registrationState: s(legalIn.registration_state, 100) || undefined,
              registrationCountry: s(legalIn.registration_country, 80) || undefined,
              formationDate: s(legalIn.formation_date, 30) || undefined,
              taxId: s(legalIn.tax_id, 40) || undefined,
              registrationNumber: s(legalIn.registration_number, 60) || undefined,
              registeredAddress: legalIn.registered_address && typeof legalIn.registered_address === "object" ? legalIn.registered_address : undefined,
            } : undefined,
          };
          if (!Object.values(patch).some((v) => v !== undefined)) {
            const blanked = ["name", "legal_name", "entity_type", "industry", "website", "description", "timezone", "owner_first_name", "owner_last_name", "owner_title"].filter((k) => typeof args[k] === "string" && !s(args[k], 5).length);
            return fail(blanked.length
              ? `Empty values are ignored: an agent can add or correct company information but cannot clear it (${blanked.join(", ")}). Ask the owner to clear a field.`
              : "Nothing to update — pass the fields you are changing.");
          }
          const before = JSON.stringify(profilePayload(profile));
          const updated = updateProfile(patch, by);
          if (JSON.stringify(profilePayload(updated)) === before) return ok("No change: the profile already holds these values.");
          const resolved = await resolveFilledRequests();
          return ok(JSON.stringify({ success: true, profile: profilePayload(updated), ...(resolved.length ? { resolved_requests: resolved.map((r) => r.label) } : {}), note: "Recorded with your name and reason. Clearing a value or deleting anything remains the owner's decision." }, null, 1));
        }
        case "add_company_contact": {
          const reason = s(args.reason, 300);
          if (!reason) return fail("reason is required.");
          const c = addContact({ type: s(args.type, 10).toUpperCase() === "PHONE" ? "PHONE" : "EMAIL", name: s(args.name, 80), value: s(args.value, 200), description: s(args.description, 600), isPrimary: typeof args.is_primary === "boolean" ? args.is_primary : undefined }, by);
          const resolved = await resolveFilledRequests();
          return ok(JSON.stringify({ success: true, contact_id: c.id, name: c.name, type: c.type, value: c.value, is_primary: c.isPrimary, ...(resolved.length ? { resolved_requests: resolved.map((r) => r.label) } : {}) }));
        }
        case "update_company_contact": {
          const reason = s(args.reason, 300);
          if (!reason) return fail("reason is required.");
          const id = s(args.contact_id, 80);
          const cur = profile.contacts.find((c) => c.id === id || c.value.toLowerCase() === id.toLowerCase() || c.name.toLowerCase() === id.toLowerCase());
          if (!cur) return fail("Company contact not found — call get_company_profile for the current contacts.");
          const patch: Record<string, unknown> = {};
          if (s(args.name, 80)) patch.name = s(args.name, 80);
          if (s(args.value, 200)) patch.value = s(args.value, 200);
          if (s(args.description, 600)) patch.description = s(args.description, 600);
          if (typeof args.is_primary === "boolean") patch.isPrimary = args.is_primary;
          if (args.status === "ACTIVE" || args.status === "INACTIVE") patch.status = args.status;
          if (!Object.keys(patch).length) return fail("Nothing to update.");
          const c = updateContact(cur.id, patch, by);
          const resolved = await resolveFilledRequests();
          return ok(JSON.stringify({ success: true, contact_id: c.id, name: c.name, value: c.value, status: c.status, is_primary: c.isPrimary, updated: Object.keys(patch), ...(resolved.length ? { resolved_requests: resolved.map((r) => r.label) } : {}) }));
        }
        default:
          return fail(`Unknown tool ${name}`);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});
