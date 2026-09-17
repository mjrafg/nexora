"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { SettingsTabs } from "@/components/layout/SettingsTabs";
import { McpServersSection } from "@/components/providers/McpServersSection";
import { CredentialsSection } from "@/components/providers/CredentialsSection";
import { api, errorText } from "@/lib/client-api";
import type { CredentialMeta, McpServerView } from "@/lib/mcp/types";

export default function McpSettingsPage() {
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [credentials, setCredentials] = useState<CredentialMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [s, c] = await Promise.all([api.mcpServers(), api.credentials()]);
    setServers(s.servers);
    setCredentials(c.credentials);
  }
  useEffect(() => {
    Promise.all([api.mcpServers(), api.credentials()])
      .then(([s, c]) => {
        setServers(s.servers);
        setCredentials(c.credentials);
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  return (
    <AppShell>
      <h1 className="text-[20px] font-semibold tracking-tight">Settings</h1>
      <p className="mb-3 text-[12.5px] text-ink-3">Company tools and integrations.</p>
      <SettingsTabs />

      {error && <div className="glass mb-4 rounded-2xl p-4 text-[12.5px] text-[#ff8ea3]">{error}</div>}
      {(!servers || !credentials) && !error ? (
        <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <McpServersSection servers={servers ?? []} credentials={credentials ?? []} onChanged={load} />
          <CredentialsSection credentials={credentials ?? []} onChanged={load} />
        </div>
      )}
    </AppShell>
  );
}
