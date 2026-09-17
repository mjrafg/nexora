import { putSecret } from "@/lib/store/db";
import { PROVIDERS } from "./catalog";
import type { AuthReference, ProviderType } from "./types";
import { RuntimeError } from "./types";
import { str } from "@/lib/api-helpers";

/** Auth as submitted by the UI. A raw apiKey is stored server-side and replaced by a secret id. */
export type AuthInput =
  | { kind: "none" }
  | { kind: "env"; variable?: string }
  | { kind: "stored"; apiKey?: string };

export function authFromInput(input: AuthInput | undefined, providerType: ProviderType, existing?: AuthReference): AuthReference {
  if (!input) return existing ?? { kind: "env", variable: PROVIDERS[providerType].envVar ?? "" };
  if (input.kind === "none") return { kind: "none" };
  if (input.kind === "env") {
    const variable = str(input.variable, 4000)?.trim() || PROVIDERS[providerType].envVar;
    if (!variable) throw new RuntimeError("Environment variable name is required");
    // Someone pasted the key itself instead of a variable name: keep it secret.
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(variable)) return { kind: "stored", secretId: putSecret(variable) };
    return { kind: "env", variable };
  }
  const apiKey = str(input.apiKey, 4000)?.trim();
  if (apiKey) return { kind: "stored", secretId: putSecret(apiKey) };
  if (existing?.kind === "stored") return existing; // keep the key already on file
  throw new RuntimeError("API key is required");
}

