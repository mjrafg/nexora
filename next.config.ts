import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright drives a real Chromium from the server process; it must not be bundled.
  serverExternalPackages: ["playwright", "playwright-core"],
  // The browser host and the file store read paths at runtime, so Next traces the
  // whole project directory. Nothing under these ever belongs in a server trace —
  // on the server, unrelated builds that happen to sit beside the deploy would
  // otherwise break it.
  outputFileTracingExcludes: {
    "/*": ["app/**/*", "**/.next/**/*", "data/**/*", ".git/**/*"],
  },
};

export default nextConfig;
