/* ------------------------------------------------------------------
   What an agent's child process must NOT inherit from Nexora itself.
   ------------------------------------------------------------------ */

/**
 * Nexora's own service runs with NODE_ENV=production. An agent inherits the
 * whole environment, so `npm install` in its workspace quietly skipped every
 * devDependency — vite, vitest, typescript — and then the checks the session
 * was told to run did not exist.
 *
 * Scrubbed at the boundary where a child process is built, not in the service:
 * nothing about how Nexora itself runs changes. A project that genuinely wants
 * a production install can still say so in the command it runs, which is where
 * that decision belongs.
 */
export function scrubAgentEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  delete out.NODE_ENV;
  return out;
}
