/* ------------------------------------------------------------------
   Static catalog of runtimes, providers and known models.
   Adding a provider or model here never touches Agent code.
   ------------------------------------------------------------------ */

import type { ProviderType, RuntimeType } from "./types";

export type KnownModel = { id: string; label: string; note?: string };

export type ProviderMeta = {
  type: ProviderType;
  label: string;
  /** Wire protocol used by the generic API runtime. */
  apiStyle: "anthropic" | "openai";
  defaultBaseUrl?: string;
  /** Conventional environment variable holding the API key. */
  envVar?: string;
  /** Which runtime types can execute through this provider. */
  runtimes: RuntimeType[];
  models: KnownModel[];
  /** Models offered when this provider is used through Codex. */
  codexModels?: KnownModel[];
  requiresBaseUrl?: boolean;
};

export type RuntimeMeta = {
  type: RuntimeType;
  label: string;
  description: string;
  providers: ProviderType[];
  cli?: string;
};

export const RUNTIMES: Record<RuntimeType, RuntimeMeta> = {
  "claude-code": {
    type: "claude-code",
    label: "Claude Code",
    description: "Runs through the Claude Code CLI (agentic, tools, sessions).",
    providers: ["anthropic"],
    cli: "claude",
  },
  codex: {
    type: "codex",
    label: "Codex",
    description: "Runs through the OpenAI Codex CLI.",
    providers: ["openai"],
    cli: "codex",
  },
  api: {
    type: "api",
    label: "API",
    description: "Direct model API call (Anthropic, OpenAI, OpenRouter or a custom OpenAI-compatible endpoint).",
    providers: ["anthropic", "openai", "openrouter", "custom"],
  },
};

const anthropicModels: KnownModel[] = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
];

const openaiModels: KnownModel[] = [
  { id: "gpt-5", label: "GPT-5" },
  { id: "gpt-5-mini", label: "GPT-5 mini" },
  { id: "gpt-5-nano", label: "GPT-5 nano" },
  { id: "gpt-5.1", label: "GPT-5.1" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "o3", label: "o3" },
  { id: "o4-mini", label: "o4-mini" },
];

/** Fallback list; at runtime the Codex adapter reads the live catalog from ~/.codex/models_cache.json. */
const codexModels: KnownModel[] = [
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  { id: "gpt-daybreak-blue-latest", label: "Daybreak Blue" },
];

const openrouterModels: KnownModel[] = [
  { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5 (via OpenRouter)" },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5 (via OpenRouter)" },
  { id: "openai/gpt-5", label: "GPT-5 (via OpenRouter)" },
  { id: "openai/gpt-4.1-mini", label: "GPT-4.1 mini (via OpenRouter)" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro (via OpenRouter)" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash (via OpenRouter)" },
  { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (via OpenRouter)" },
  { id: "deepseek/deepseek-chat-v3-0324", label: "DeepSeek V3 (via OpenRouter)" },
];

export const PROVIDERS: Record<ProviderType, ProviderMeta> = {
  anthropic: {
    type: "anthropic",
    label: "Anthropic",
    apiStyle: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    envVar: "ANTHROPIC_API_KEY",
    runtimes: ["claude-code", "api"],
    models: anthropicModels,
  },
  openai: {
    type: "openai",
    label: "OpenAI",
    apiStyle: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    envVar: "OPENAI_API_KEY",
    runtimes: ["codex", "api"],
    models: openaiModels,
    codexModels,
  },
  openrouter: {
    type: "openrouter",
    label: "OpenRouter",
    apiStyle: "openai",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    envVar: "OPENROUTER_API_KEY",
    runtimes: ["api"],
    models: openrouterModels,
  },
  custom: {
    type: "custom",
    label: "Custom API (OpenAI-compatible)",
    apiStyle: "openai",
    envVar: "CUSTOM_API_KEY",
    runtimes: ["api"],
    models: [],
    requiresBaseUrl: true,
  },
};

export const DEFAULT_RUNTIME: { runtimeType: RuntimeType; providerType: ProviderType; model: string } = {
  runtimeType: "claude-code",
  providerType: "anthropic",
  model: "claude-haiku-4-5",
};

export function knownModelsFor(runtimeType: RuntimeType, providerType: ProviderType): KnownModel[] {
  const p = PROVIDERS[providerType];
  if (!p) return [];
  if (runtimeType === "codex") return p.codexModels ?? p.models;
  return p.models;
}

export function modelLabel(providerType: ProviderType, runtimeType: RuntimeType, id: string): string {
  return knownModelsFor(runtimeType, providerType).find((m) => m.id === id)?.label ?? id;
}

export const TOOL_CATALOG: { id: string; label: string; description: string }[] = [
  { id: "web_search", label: "Web search", description: "Search the web for information." },
  { id: "web_fetch", label: "Web fetch", description: "Fetch and read web pages." },
  { id: "read_files", label: "Read files", description: "Read files in the agent workspace." },
  { id: "write_files", label: "Write files", description: "Create and edit files in the agent workspace." },
  { id: "run_commands", label: "Run commands", description: "Execute shell commands in the workspace." },
  { id: "credentials", label: "Credentials: use", description: "List saved company logins and have Nexora insert them into browser login fields; request missing ones from the owner." },
  { id: "credentials_manage", label: "Credentials: create & update", description: "Generate passwords, save accounts the agent created, and update saved credentials." },
  { id: "payments", label: "Payments: request", description: "Request company payments within the owner's automatic spending limit and approvals; record the outcome." },
  { id: "payments_use", label: "Payments: use", description: "List saved payment methods (safe metadata + usage descriptions) and have Nexora insert the chosen one into checkout fields for an approved payment." },
  { id: "payments_manage", label: "Payments: create & update", description: "Save payment methods the agent obtained (e.g. a virtual card issued at signup) and update saved ones." },
  { id: "company_profile", label: "Company profile", description: "Read Nexora's canonical company information (name, contacts, addresses, legal data) instead of guessing it, and ask the owner for a missing value." },
  { id: "company_custom_data_manage", label: "Company data: save", description: "Save reusable non-secret company data (defaults, preferences, identifiers) as provisional entries the owner can verify." },
  { id: "company_profile_manage", label: "Company profile: update", description: "Correct or add company information (details, addresses, contact methods) programmatically. Values can be added or fixed, never cleared or deleted, and every change is audited." },
  { id: "browser", label: "Web browser", description: "Drive Nexora's built-in Chromium: open sites, read pages, click, fill forms, take screenshots. Independent of the AI runtime." },
  { id: "send_email", label: "Send email", description: "Send email on behalf of the company (future)." },
  { id: "crm", label: "CRM access", description: "Read and update CRM records (future)." },
];
