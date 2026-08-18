import { RuntimeSecretValidationError, validateRuntimeSecrets } from "./runtime-secrets.mjs";

/**
 * Validates secrets and terminates before supported launchers open a request listener. The
 * direct Next CLI initializes its own listener unusually early, so instrumentation also uses
 * a hard exit to ensure an unsupported wrapper bypass cannot remain online when invalid.
 */
export function validateRuntimeSecretsOrExit() {
  try {
    validateRuntimeSecrets();
  } catch (error) {
    const message = error instanceof RuntimeSecretValidationError ? error.message : "Runtime secret validation failed unexpectedly.";
    console.error(`[vicky] ${message}`);
    process.exit(1);
  }
}
