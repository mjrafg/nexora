"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Form";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      if (!res.ok) {
        setError(body.detail ? `${body.error} ${body.detail}` : body.error ?? "Login failed");
        setBusy(false);
        return;
      }
      const next = params.get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
      router.refresh();
    } catch {
      setError("Could not reach the server");
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-[#7d8bff] via-[#5a6bff] to-[#2fd4e6] shadow-[0_8px_24px_-8px_rgba(109,124,255,0.9)]">
            <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 19V5l14 14V5" />
            </svg>
          </div>
          <div className="leading-tight">
            <div className="text-[17px] font-semibold tracking-tight">Nexora OS</div>
            <div className="text-[11px] text-ink-3">Sign in to run your company.</div>
          </div>
        </div>

        <form onSubmit={submit} className="glass space-y-4 rounded-2xl p-5">
          <Field label="Username" htmlFor="username">
            <Input id="username" name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input id="password" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          {error && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-[#ff8ea3]">{error}</div>}
          <Button type="submit" variant="primary" size="md" className="w-full" disabled={busy || !username || !password}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />} Sign in
          </Button>
        </form>
      </div>
    </main>
  );
}
