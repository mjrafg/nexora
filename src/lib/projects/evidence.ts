/* ------------------------------------------------------------------
   What the Reviewer is told about the work it is judging.

   Two kinds of thing, kept apart on purpose: what the session SAID it
   did, and what the engine WATCHED it do. A Reviewer that cannot tell
   them apart cannot weigh them.

   Import-free so the shape can be checked directly — a Reviewer once
   reported "This session gave me the changed-file list but not the
   builder's written evidence block", and it was right.
   ------------------------------------------------------------------ */

/** What the session actually did, as opposed to what it said it did. */
export type WorkEvidence = {
  /** commit or tree the review is judging, when known */
  snapshot?: string;
  /** the worker's final message — a claim */
  report?: string;
  /** commands the engine watched run, newest last */
  executions?: { command: string; cwd?: string; status?: string; exitCode?: number; durationMs?: number; output?: string }[];
};

const EXEC_CAP = 24;
const OUT_CAP = 400;

export function evidenceFields(e: WorkEvidence, key: string): { snapshot: string; report: string; executions: string } {
  const snapshot = [e.snapshot ? `Session ${key}, at ${e.snapshot}.` : `Session ${key}.`].join(" ");
  const report = e.report?.trim() ? e.report.trim().slice(0, 8_000) : "(the session left no written report)";
  const runs = (e.executions ?? []).slice(-EXEC_CAP);
  const executions = runs.length
    ? runs
        .map((r) => {
          const head = [`$ ${r.command.replace(/\s+/g, " ").slice(0, 220)}`, r.cwd ? `  in ${r.cwd}` : "", `  ${r.status ?? "?"}${r.exitCode === undefined ? "" : ` · exit ${r.exitCode}`}${r.durationMs ? ` · ${Math.round(r.durationMs / 100) / 10}s` : ""}`]
            .filter(Boolean)
            .join("\n");
          const out = r.output?.trim() ? `\n  ${r.output.trim().replace(/\s*\n\s*/g, "\n  ").slice(0, OUT_CAP)}${r.output.trim().length > OUT_CAP ? "\n  … (truncated; the session's full step record holds the rest)" : ""}` : "";
          return head + out;
        })
        .join("\n\n") + ((e.executions?.length ?? 0) > EXEC_CAP ? `\n\n(${(e.executions?.length ?? 0) - EXEC_CAP} earlier command(s) omitted; the session's step record holds them all)` : "")
    : "(the engine recorded no command executions for this session — so nothing here has been observed running)";
  return { snapshot, report, executions };
}
