export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // Keep the validator out of non-Node bundles while still guarding direct `next dev` and
  // `next start` use that bypasses the repository's npm launch wrappers.
  const { validateRuntimeSecretsOrExit } = await import("@/lib/runtime-secret-startup.mjs");
  validateRuntimeSecretsOrExit();

  // Supported launchers acquire and preflight the exclusive local-runtime lease before
  // they create Next. Verifying the inherited nonce here prevents direct CLI bypasses
  // from silently starting an uncoordinated application process.
  const { verifyInheritedRuntimeOwnerLeaseOrExit } = await import("@/lib/runtime-topology.mjs");
  await verifyInheritedRuntimeOwnerLeaseOrExit();
}
