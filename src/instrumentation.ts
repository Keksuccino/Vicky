export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // Keep the validator out of non-Node bundles while still guarding direct `next dev` and
  // `next start` use that bypasses the repository's npm launch wrappers.
  const { validateRuntimeSecretsOrExit } = await import("@/lib/runtime-secret-startup.mjs");
  validateRuntimeSecretsOrExit();
}
