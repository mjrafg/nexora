"use client";

import { useState } from "react";
import { Check, Loader2, Lock, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CharCount, Field, Input, Missing, Select, Textarea, describeShortfall } from "@/components/ui/Form";
import { api, errorText, type CredentialRequest, type LoginCredentialView } from "@/lib/client-api";
import { ErrorBox, Modal } from "@/components/payments/shared";

const MIN_DESCRIPTION = 20;

/** "google.com" is what people type; the store wants a real URL. */
function normalizeUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

export function CredentialDialog({ existing, request, onClose, onSaved }: { existing?: LoginCredentialView; request?: CredentialRequest; onClose: () => void; onSaved: (c: LoginCredentialView) => void }) {
  const [form, setForm] = useState({
    name: existing?.name ?? (request ? `${request.service} — Agent24` : ""),
    service: existing?.service ?? request?.service ?? "",
    site: existing?.site ?? request?.site ?? "",
    loginUrl: existing?.loginUrl ?? request?.loginUrl ?? "",
    description: existing?.description ?? (request ? `${request.service} account for ${request.site}. ${request.reason}` : ""),
    username: "",
    password: "",
    type: existing?.type ?? "username_password",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  // what is still missing, in the owner's words — never a silently dead button
  const problems = [
    !form.name.trim() && "a name",
    !form.service.trim() && "the service",
    !form.site.trim() && "the website or domain",
    describeShortfall("a longer description", form.description, MIN_DESCRIPTION),
    !existing && !form.username.trim() && "the username or email",
    !existing && !form.password && "the password",
  ].filter((x): x is string => typeof x === "string");
  const valid = problems.length === 0;

  async function save() {
    setBusy(true);
    setErr(null);
    // a login URL typed the way people say it ("google.com") is a URL
    const loginUrl = normalizeUrl(form.loginUrl);
    try {
      if (existing) {
        const body: Record<string, unknown> = { name: form.name, service: form.service, site: form.site, loginUrl, description: form.description, type: form.type };
        if (form.username.trim()) body.username = form.username;
        if (form.password) body.password = form.password;
        const r = await api.updateLogin(existing.id, body);
        onSaved(r.credential);
      } else {
        const r = await api.createLogin({ ...form, loginUrl, requestId: request?.id });
        onSaved(r.credential);
      }
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={existing ? `Edit ${existing.name}` : request ? `Add credential for ${request.service}` : "Add credential"} subtitle={request ? `Requested by ${request.requesterName} — they resume automatically once you save.` : "The password is encrypted in the vault and only ever typed into login fields by Nexora."} onClose={onClose} width="max-w-xl">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2"><Input value={form.name} onChange={set("name")} placeholder="Google Ads — Agent24" autoFocus /></Field>
        <Field label="Service"><Input value={form.service} onChange={set("service")} placeholder="Google" /></Field>
        <Field label="Website / Domain"><Input value={form.site} onChange={set("site")} placeholder="ads.google.com" /></Field>
        <Field label="Login URL" className="sm:col-span-2"><Input value={form.loginUrl} onChange={set("loginUrl")} placeholder="https://ads.google.com/" /></Field>
        <Field
          label="Description"
          className="sm:col-span-2"
          hint={
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span>Describe exactly which site/account this credential is for and what it should be used for — your agents choose between credentials by reading this.</span>
              <CharCount value={form.description} min={MIN_DESCRIPTION} />
            </span>
          }
        >
          <Textarea rows={3} value={form.description} onChange={set("description")} placeholder="Main Agent24 Google account used specifically for Google Ads campaign creation, billing and analytics." />
        </Field>
        <Field label="Username / Email"><Input value={form.username} onChange={set("username")} placeholder={existing ? `Unchanged (${existing.usernameMasked})` : "marketing@agent24.io"} autoComplete="off" /></Field>
        <Field label="Password"><Input type="password" value={form.password} onChange={set("password")} placeholder={existing ? "Unchanged" : "••••••••••••"} autoComplete="new-password" /></Field>
        <Field label="Type">
          <Select value={form.type} onChange={set("type")}>
            <option value="username_password">Username &amp; password</option>
            <option value="api_key">API key</option>
            <option value="token">Token</option>
          </Select>
        </Field>
      </div>
      {err && <div className="mt-3"><ErrorBox text={err} /></div>}
      <div className="sticky -bottom-4 -mx-5 mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line bg-bg-2/95 px-5 py-3 backdrop-blur">
        {valid
          ? <span className="flex items-center gap-1.5 text-[11px] text-ink-3"><Lock className="h-3 w-3" /> Never shown again after saving.</span>
          : <Missing problems={problems} />}
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}><X className="h-3.5 w-3.5" /> Cancel</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={busy || !valid}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {existing ? "Save changes" : request ? "Save & resume agent" : "Save credential"}</Button>
        </div>
      </div>
    </Modal>
  );
}
