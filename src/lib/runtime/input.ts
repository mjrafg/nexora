import type { AdvancedSettings, RuntimeType } from "./types";

export type RuntimeInput = {
  runtimeType?: RuntimeType;
  providerConnectionId?: string;
  model?: string;
  advancedSettings?: AdvancedSettings;
};

export function cleanAdvanced(a: AdvancedSettings | undefined): AdvancedSettings {
  if (!a || typeof a !== "object") return {};
  const out: AdvancedSettings = {};
  if (typeof a.maxTokens === "number" && a.maxTokens > 0) out.maxTokens = Math.floor(a.maxTokens);
  if (typeof a.temperature === "number" && a.temperature >= 0 && a.temperature <= 2) out.temperature = a.temperature;
  if (typeof a.maxTurns === "number" && a.maxTurns > 0) out.maxTurns = Math.floor(a.maxTurns);
  if (typeof a.workingDirectory === "string" && a.workingDirectory.trim()) out.workingDirectory = a.workingDirectory.trim();
  if (a.reasoningEffort && ["low", "medium", "high"].includes(a.reasoningEffort)) out.reasoningEffort = a.reasoningEffort;
  return out;
}
