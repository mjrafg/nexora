"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, LogIn, LogOut, Terminal, Cpu, XCircle, RefreshCw } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Form";
import { errorText } from "@/lib/client-api";
import type { LoginRuntime, LoginSession, RuntimeLoginStatus } from "@/lib/runtime/logins";
import { cn } from "@/lib/utils";

type Overview = { status: Record<LoginRuntime, RuntimeLoginStatus>; sessions: LoginSession[] };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string } & T;
  if (!res.ok) throw new Error(body.detail ? `${body.error} — ${body.detail}` : body.error ?? `Request failed (${res.status})`);
  return body;
}

/** Sign in to the Claude Code and Codex CLIs from the browser. */
export function RuntimeLogins() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setOverview(await call<Overview>("/api/runtime-logins"));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    call<Overview>("/api/runtime-logins")
      .then((o) => setOverview(o))
      .catch((e) => setError(errorText(e)));
  }, []);

  return (
    <Panel
      title="Runtime logins"
      subtitle="Sign in to the Claude Code and Codex CLIs on this server without leaving the browser"
      action={
        <Button variant="ghost" size="xs" onClick={refresh}>
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
      }
    >
      {error && <div className="mb-3 text-[12px] text-[#ff8ea3]">{error}</div>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <LoginCard
          runtime="claude-code"
          label="Claude Code"
          icon={<Terminal className="h-4 w-4" />}
          color="#d9a45b"
          status={overview?.status["claude-code"]}
          session={overview?.sessions.find((s) => s.runtime === "claude-code" && !["completed", "failed", "cancelled"].includes(s.status))}
          onChanged={refresh}
        />
        <LoginCard
          runtime="codex"
          label="Codex"
          icon={<Cpu className="h-4 w-4" />}
          color="#7de8b3"
          status={overview?.status.codex}
          session={overview?.sessions.find((s) => s.runtime === "codex" && !["completed", "failed", "cancelled"].includes(s.status))}
          onChanged={refresh}
        />
      </div>
    </Panel>
  );
}

function LoginCard({
  runtime,
  label,
  icon,
  color,
  status,
  session: initialSession,
  onChanged,
}: {
  runtime: LoginRuntime;
  label: string;
  icon: React.ReactNode;
  color: string;
  status?: RuntimeLoginStatus;
  session?: LoginSession;
  onChanged: () => Promise<void>;
}) {
  const [localSession, setSession] = useState<LoginSession | null>(null);
  // A session already running on the server (e.g. after a page reload) is shown until we track our own.
  const session = localSession ?? initialSession ?? null;
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll the active session.
  useEffect(() => {
    if (!session || ["completed", "failed", "cancelled"].includes(session.status)) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return;
    }
    timer.current = setInterval(async () => {
      try {
        const r = await call<{ session: LoginSession }>(`/api/runtime-logins/${session.id}`);
        setSession(r.session);
        if (["completed", "failed", "cancelled"].includes(r.session.status)) void onChanged();
      } catch (e) {
        setErr(errorText(e));
      }
    }, 2000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [session, onChanged]);

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      const r = await call<{ session: LoginSession }>("/api/runtime-logins/start", { method: "POST", body: JSON.stringify({ runtime }) });
      setSession(r.session);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!session) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await call<{ session: LoginSession }>(`/api/runtime-logins/${session.id}/code`, { method: "POST", body: JSON.stringify({ code }) });
      setSession(r.session);
      setCode("");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!session) return;
    const r = await call<{ session: LoginSession | null }>(`/api/runtime-logins/${session.id}/cancel`, { method: "POST" }).catch(() => null);
    setSession(r?.session ?? null);
    void onChanged();
  }

  async function signOut() {
    if (!window.confirm(`Sign out of ${label} on the server?`)) return;
    setBusy(true);
    try {
      await call("/api/runtime-logins/logout", { method: "POST", body: JSON.stringify({ runtime }) });
      setSession(null);
      await onChanged();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const active = session && !["completed", "failed", "cancelled"].includes(session.status);

  return (
    <div className="rounded-xl border border-line bg-white/[0.02] p-3">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: `${color}1a`, color }}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{label}</div>
          <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
            {!status ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: status.loggedIn ? "#3dd68c" : status.installed ? "#f5b942" : "#ff5c7a" }} />
            )}
            <span className="truncate">{status?.detail ?? "Checking…"}</span>
            {status?.method && status.loggedIn && <span className="text-ink-3">· {status.method}</span>}
          </div>
        </div>
        {!active && status?.installed && (
          <div className="flex gap-1">
            <Button variant="primary" size="xs" onClick={start} disabled={busy}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogIn className="h-3 w-3" />} {status.loggedIn ? "Re-login" : "Log in"}
            </Button>
            {status.loggedIn && (
              <Button variant="ghost" size="xs" onClick={signOut} disabled={busy} title="Sign out">
                <LogOut className="h-3 w-3" />
              </Button>
            )}
          </div>
        )}
      </div>

      {session && (
        <div className={cn("mt-3 space-y-2 rounded-lg border p-3 text-[12px]", session.status === "failed" ? "border-danger/30 bg-danger/10" : session.status === "completed" ? "border-success/30 bg-success/10" : "border-line bg-white/[0.03]")}>
          {session.status === "starting" && (
            <div className="flex items-center gap-2 text-ink-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Starting {label} login…
            </div>
          )}

          {(session.status === "awaiting-browser" || session.status === "awaiting-code") && (
            <>
              <div className="text-ink">
                <span className="font-medium">1.</span> Open this link and sign in
                {runtime === "codex" && session.code && (
                  <>
                    , then enter the code <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[13px] tracking-widest text-ink">{session.code}</span>
                  </>
                )}
                .
              </div>
              {session.url && (
                <a href={session.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:text-ink">
                  <ExternalLink className="h-3.5 w-3.5" /> {runtime === "codex" ? "auth.openai.com/codex/device" : "claude.com — authorize Claude Code"}
                </a>
              )}
              {runtime === "claude-code" ? (
                <div>
                  <div className="mb-1 text-ink">
                    <span className="font-medium">2.</span> Paste the code Claude shows you here.
                  </div>
                  <div className="flex gap-1.5">
                    <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="authorization code" className="h-8 font-mono text-[12px]" autoComplete="off" />
                    <Button variant="primary" size="sm" onClick={submit} disabled={busy || !code.trim()}>
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Submit"}
                    </Button>
                  </div>
                  {session.message && <div className="mt-1 text-ink-3">{session.message}</div>}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-ink-3">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for you to finish in the browser… (code expires in 15 minutes)
                </div>
              )}
              <div>
                <Button variant="ghost" size="xs" onClick={cancel}>
                  Cancel
                </Button>
              </div>
            </>
          )}

          {session.status === "exchanging" && (
            <div className="flex items-center gap-2 text-ink-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {session.message ?? "Exchanging code for a token…"}
            </div>
          )}

          {session.status === "completed" && (
            <div className="flex items-start gap-2 text-[#7de8b3]">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>{session.message ?? "Logged in."}</span>
            </div>
          )}
          {(session.status === "failed" || session.status === "cancelled") && (
            <div className="flex items-start gap-2 text-[#ff8ea3]">
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span className="whitespace-pre-wrap break-words">{session.message ?? session.status}</span>
            </div>
          )}
        </div>
      )}
      {err && <div className="mt-2 text-[11px] text-[#ff8ea3]">{err}</div>}
    </div>
  );
}
