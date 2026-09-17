import type { ProviderConnection } from "@/lib/runtime/types";
import { resolveSecret } from "@/lib/runtime";

/** What the UI sees: never the secret itself. */
export type ProviderConnectionView = Omit<ProviderConnection, "auth"> & {
  auth: { kind: ProviderConnection["auth"]["kind"]; variable?: string };
  authConfigured: boolean;
};

export function toConnectionView(c: ProviderConnection): ProviderConnectionView {
  const { auth, ...rest } = c;
  return {
    ...rest,
    auth: auth.kind === "env" ? { kind: "env", variable: auth.variable } : { kind: auth.kind },
    authConfigured: auth.kind === "none" ? true : resolveSecret(c) !== null,
  };
}
