/** Runs once when the Next.js server starts; all Node-only work lives in lib/boot.ts. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootNexora } = await import("@/lib/boot");
    bootNexora();
  }
}
