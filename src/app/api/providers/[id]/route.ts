import { NextResponse } from "next/server";
import { deleteSecret, now, updateDb } from "@/lib/store/db";
import { PROVIDERS } from "@/lib/runtime/catalog";
import { RuntimeError } from "@/lib/runtime/types";
import { toConnectionView } from "@/lib/providers-view";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { authFromInput, type AuthInput } from "@/lib/runtime/auth-input";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await readJson<{ name?: string; baseUrl?: string; auth?: AuthInput }>(req);
    const conn = updateDb((d) => {
      const c = d.providerConnections.find((x) => x.id === id);
      if (!c) throw new RuntimeError("Connection not found");
      const name = str(body.name, 80)?.trim();
      if (name) c.name = name;
      if (body.baseUrl !== undefined) {
        const baseUrl = str(body.baseUrl, 500)?.trim();
        if (PROVIDERS[c.providerType].requiresBaseUrl && !baseUrl) throw new RuntimeError("Base URL is required");
        c.baseUrl = baseUrl || PROVIDERS[c.providerType].defaultBaseUrl;
      }
      if (body.auth) {
        const previous = c.auth;
        c.auth = authFromInput(body.auth, c.providerType, previous);
        if (previous.kind === "stored" && (c.auth.kind !== "stored" || c.auth.secretId !== previous.secretId)) {
          deleteSecret(previous.secretId);
        }
        c.status = "unknown";
        c.lastError = undefined;
      }
      c.updatedAt = now();
      return c;
    });
    return NextResponse.json({ connection: toConnectionView(conn) });
  } catch (err) {
    return jsonError(err, err instanceof RuntimeError && err.message === "Connection not found" ? 404 : 400);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    updateDb((d) => {
      const c = d.providerConnections.find((x) => x.id === id);
      if (!c) throw new RuntimeError("Connection not found");
      const inUse = d.runtimeConfigs.filter((r) => r.providerConnectionId === id).length;
      if (inUse) throw new RuntimeError(`Connection is used by ${inUse} agent${inUse === 1 ? "" : "s"}`, "Move those agents to another connection first.");
      if (c.auth.kind === "stored") deleteSecret(c.auth.secretId);
      d.providerConnections = d.providerConnections.filter((x) => x.id !== id);
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err, err instanceof RuntimeError && err.message === "Connection not found" ? 404 : 400);
  }
}
