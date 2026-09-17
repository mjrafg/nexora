import { NextResponse } from "next/server";
import { RuntimeError } from "@/lib/runtime/types";

export function jsonError(err: unknown, status = 400) {
  if (err instanceof RuntimeError) {
    return NextResponse.json({ error: err.message, detail: err.detail }, { status });
  }
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ error: message }, { status });
}

export function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new RuntimeError("Invalid JSON body");
  }
}

export const str = (v: unknown, max = 20_000) => (typeof v === "string" ? v.slice(0, max) : undefined);
export const strList = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean) : undefined;
