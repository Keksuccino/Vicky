const AUTOMATED_TEST_SIGNAL_NAME = "VICKY_AUTOMATED_TEST_RUN";
const AUTOMATED_TEST_SIGNAL_VALUE = "vitest";

export const RUNTIME_SECRET_NAMES = Object.freeze(["AUTH_JWT_SECRET", "ENCRYPTION_SECRET", "ADMIN_PASSWORD"]);

const SECRET_POLICIES = Object.freeze({
  AUTH_JWT_SECRET: Object.freeze({ minimumLength: 32, minimumDistinctCharacters: 10, minimumEntropyBits: 80 }),
  ENCRYPTION_SECRET: Object.freeze({ minimumLength: 32, minimumDistinctCharacters: 10, minimumEntropyBits: 80 }),
  ADMIN_PASSWORD: Object.freeze({ minimumLength: 14, minimumDistinctCharacters: 8, minimumEntropyBits: 50 }),
});

const TEST_FALLBACKS = Object.freeze({
  AUTH_JWT_SECRET: "Q7fJ9xV2mK8pR4sW6yB3nD5hL1cT0zGvAqEu",
  ENCRYPTION_SECRET: "N4wC8kU1rZ6dP9xF3mT7qH2sV5bJ0yLgEeAi",
  ADMIN_PASSWORD: "Vicky tests: cedar! orbit7 glass",
});

const COMMON_PLACEHOLDERS = new Set([
  "123456",
  "admin",
  "admin123",
  "adminpassword",
  "changeme",
  "changethisadminpassword",
  "defaultpassword",
  "defaultsecret",
  "developmentsecret",
  "devsecret",
  "examplepassword",
  "examplesecret",
  "insertpasswordhere",
  "insertsecrethere",
  "letmein",
  "mysecret",
  "nextauthsecret",
  "password",
  "password123",
  "placeholder",
  "placeholderpassword",
  "placeholdersecret",
  "pleasechangeme",
  "putpasswordhere",
  "putsecrethere",
  "qwerty",
  "replaceme",
  "replacewithlongrandomsecret",
  "secret",
  "secret123",
  "supersecret",
  "temporarypassword",
  "temporarysecret",
  "tbd",
  "test",
  "testadminpassword",
  "testauthjwtsecret",
  "testencryptionsecret",
  "testpassword",
  "testsecret",
  "yourpassword",
  "yourpasswordhere",
  "yoursecret",
  "yoursecrethere",
]);

const PLACEHOLDER_PATTERNS = Object.freeze([
  /^(?:change|replace|insert|put|set|enter)(?:this|the|your|my|a|an|with|to|long|strong|random|secure|admin|auth|jwt|encryption|session)*(?:password|secret|token|key|value)(?:here|now)?$/,
  /^(?:your|my|example|sample|demo|default|dev|development|test|temp|temporary)(?:admin|auth|jwt|encryption|session)*(?:password|secret|token|key|value)(?:here|now)?$/,
  /^(?:thisis|thisisa)(?:long|strong|random|secure|admin|auth|jwt|encryption|session)*(?:password|secret|token|key|value)$/,
]);

const normalizeForPlaceholderCheck = (value) => value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");

const calculateCharacterEntropyBits = (value) => {
  const characters = Array.from(value);
  const frequencies = new Map();
  for (const character of characters) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }

  let bitsPerCharacter = 0;
  for (const count of frequencies.values()) {
    const probability = count / characters.length;
    bitsPerCharacter -= probability * Math.log2(probability);
  }

  return bitsPerCharacter * characters.length;
};

const isRepeatedPattern = (value) => {
  const characters = Array.from(value);
  const prefixLengths = new Array(characters.length).fill(0);
  for (let index = 1; index < characters.length; index += 1) {
    let matchedLength = prefixLengths[index - 1];
    while (matchedLength > 0 && characters[index] !== characters[matchedLength]) {
      matchedLength = prefixLengths[matchedLength - 1];
    }

    if (characters[index] === characters[matchedLength]) {
      matchedLength += 1;
    }

    prefixLengths[index] = matchedLength;
  }

  const repeatedUnitLength = characters.length - prefixLengths[characters.length - 1];
  return repeatedUnitLength < characters.length && characters.length % repeatedUnitLength === 0;
};

const isExplicitAutomatedTestRun = (environment) => environment.VITEST === "true" && environment[AUTOMATED_TEST_SIGNAL_NAME] === AUTOMATED_TEST_SIGNAL_VALUE;

const resolveSecretValue = (secretName, environment) => {
  const rawValue = environment[secretName];
  if (typeof rawValue === "string" && rawValue.trim()) {
    return { value: rawValue.trim(), hasSurroundingWhitespace: rawValue !== rawValue.trim() };
  }

  // NODE_ENV is intentionally insufficient. Only Vitest receives both signals, so an
  // ordinary process cannot enable embedded credentials merely by claiming to be a test.
  if (isExplicitAutomatedTestRun(environment)) {
    return { value: TEST_FALLBACKS[secretName], hasSurroundingWhitespace: false };
  }

  return { value: null, hasSurroundingWhitespace: false };
};

const validateSecretValue = (secretName, resolved) => {
  const issues = [];
  const policy = SECRET_POLICIES[secretName];
  if (!resolved.value) {
    issues.push(`${secretName} is missing. Set it to a unique value with at least ${policy.minimumLength} characters.`);
    return issues;
  }

  if (resolved.hasSurroundingWhitespace) {
    issues.push(`${secretName} has leading or trailing whitespace. Remove it so deployments interpret the value consistently.`);
  }

  const characters = Array.from(resolved.value);
  const distinctCharacters = new Set(characters).size;
  if (characters.length < policy.minimumLength) {
    issues.push(`${secretName} must contain at least ${policy.minimumLength} characters.`);
  }

  const normalizedPlaceholderCandidate = normalizeForPlaceholderCheck(resolved.value);
  if (COMMON_PLACEHOLDERS.has(normalizedPlaceholderCandidate) || PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalizedPlaceholderCandidate))) {
    issues.push(`${secretName} uses a documented or common placeholder. Generate a new deployment-specific value.`);
  }

  if (distinctCharacters < policy.minimumDistinctCharacters || calculateCharacterEntropyBits(resolved.value) < policy.minimumEntropyBits || isRepeatedPattern(resolved.value)) {
    issues.push(`${secretName} is too predictable. Use a random value or a long, unique passphrase with more character variety.`);
  }

  return issues;
};

const findUniquenessIssues = (resolvedValues) => {
  const issues = [];
  for (let leftIndex = 0; leftIndex < RUNTIME_SECRET_NAMES.length; leftIndex += 1) {
    const leftName = RUNTIME_SECRET_NAMES[leftIndex];
    const leftValue = resolvedValues[leftName].value;
    if (!leftValue) {
      continue;
    }

    for (let rightIndex = leftIndex + 1; rightIndex < RUNTIME_SECRET_NAMES.length; rightIndex += 1) {
      const rightName = RUNTIME_SECRET_NAMES[rightIndex];
      const rightValue = resolvedValues[rightName].value;
      if (rightValue && leftValue.normalize("NFKC").toLowerCase() === rightValue.normalize("NFKC").toLowerCase()) {
        issues.push(`${leftName} and ${rightName} must use different values.`);
      }
    }
  }

  return issues;
};

export class RuntimeSecretValidationError extends Error {
  constructor(issues) {
    super(`Invalid runtime secret configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}\nGenerate independent secrets before starting Vicky; no secret values were logged.`);
    this.name = "RuntimeSecretValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

/**
 * Validates the complete authentication and encryption configuration before startup.
 * The returned object is useful to tests and future startup consumers, but callers must
 * never log it because it contains the resolved secret values.
 *
 * @param {Record<string, string | undefined>} [environment]
 */
export function validateRuntimeSecrets(environment = process.env) {
  const resolvedValues = Object.fromEntries(RUNTIME_SECRET_NAMES.map((secretName) => [secretName, resolveSecretValue(secretName, environment)]));
  const issues = RUNTIME_SECRET_NAMES.flatMap((secretName) => validateSecretValue(secretName, resolvedValues[secretName]));
  issues.push(...findUniquenessIssues(resolvedValues));
  if (issues.length > 0) {
    throw new RuntimeSecretValidationError(issues);
  }

  return Object.freeze(Object.fromEntries(RUNTIME_SECRET_NAMES.map((secretName) => [secretName, resolvedValues[secretName].value])));
}

/**
 * Applies the same per-value policy when a secret is consumed. Startup validation remains
 * responsible for cross-secret uniqueness, while this guard prevents unsafe direct imports.
 *
 * @param {string} secretName
 * @param {Record<string, string | undefined>} [environment]
 */
export function getRuntimeSecret(secretName, environment = process.env) {
  if (!RUNTIME_SECRET_NAMES.includes(secretName)) {
    throw new TypeError("Unknown runtime secret name.");
  }

  const resolved = resolveSecretValue(secretName, environment);
  const issues = validateSecretValue(secretName, resolved);
  if (issues.length > 0) {
    throw new RuntimeSecretValidationError(issues);
  }

  return resolved.value;
}
