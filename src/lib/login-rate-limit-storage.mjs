import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { normalizeClientIp } from "./client-ip-policy.mjs";
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "./runtime-file-security.mjs";

const SCHEMA_VERSION = 1;
const LEGACY_STORE_VERSION = 1;
const LEGACY_MIGRATION_KEY = "legacy_json_v1";
const LEGACY_MAX_BYTES = 8 * 1024 * 1024;
const GLOBAL_SAFETY_IDENTITY = "__global__";

const isMissingPathError = (error) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const toSafeTimestamp = (value) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("legacy state contains an invalid timestamp");
  }

  return value;
};

const mergeLegacyState = (target, source) => {
  target.failedAt.push(...source.failedAt);
  target.blockedUntil = Math.max(target.blockedUntil, source.blockedUntil);
  target.lastSeenAt = Math.max(target.lastSeenAt, source.lastSeenAt);
};

const parseLegacyStore = (raw, maxIdentities) => {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || parsed.version !== LEGACY_STORE_VERSION || typeof parsed.entries !== "object" || parsed.entries === null || Array.isArray(parsed.entries)) {
    throw new Error("legacy state has an unsupported structure or version");
  }

  const entries = new Map();
  let knownIdentityCount = 0;
  for (const [rawIdentity, rawState] of Object.entries(parsed.entries)) {
    const normalizedIdentity = rawIdentity === "unknown" ? "unknown" : normalizeClientIp(rawIdentity);
    if (!normalizedIdentity || typeof rawState !== "object" || rawState === null || Array.isArray(rawState)) {
      throw new Error("legacy state contains an invalid identity or entry");
    }

    const failedAtRaw = rawState.failedAt;
    if (!Array.isArray(failedAtRaw)) {
      throw new Error("legacy state contains an invalid failure list");
    }

    const state = {
      failedAt: failedAtRaw.map(toSafeTimestamp),
      blockedUntil: toSafeTimestamp(rawState.blockedUntil),
      lastSeenAt: toSafeTimestamp(rawState.lastSeenAt),
    };
    let identity = normalizedIdentity;
    if (identity !== "unknown" && !entries.has(identity)) {
      if (knownIdentityCount >= maxIdentities) {
        // A legacy file can predate the bounded schema. Excess identities are merged into
        // the explicit global bucket so migration remains conservative without unbounded growth.
        identity = "unknown";
      } else {
        knownIdentityCount += 1;
      }
    }

    const existing = entries.get(identity);
    if (existing) {
      mergeLegacyState(existing, state);
    } else {
      entries.set(identity, state);
    }
  }

  return entries;
};

const readLegacyMigration = (legacyStorePath, maxIdentities) => {
  if (!legacyStorePath) {
    return { kind: "absent" };
  }

  let legacyStat;
  try {
    legacyStat = statSync(legacyStorePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { kind: "absent" };
    }
    throw error;
  }

  if (!legacyStat.isFile()) {
    return { kind: "corrupt", reason: "legacy path is not a regular file" };
  }
  if (legacyStat.size > LEGACY_MAX_BYTES) {
    return { kind: "corrupt", reason: "legacy state exceeds the migration size limit" };
  }

  ensurePrivateFileSync(legacyStorePath);
  try {
    return { kind: "valid", entries: parseLegacyStore(readFileSync(legacyStorePath, "utf8"), maxIdentities) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "legacy state could not be parsed";
    return { kind: "corrupt", reason };
  }
};

const ensurePrivateSqliteFiles = (dbPath) => {
  // Native SQLite creates sidecars outside Node's mode-aware file APIs. A 0700 parent
  // prevents exposure during creation; immediate repair guarantees their steady state.
  for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
    ensurePrivateFileSync(filePath);
  }
};

const initializeSchema = (db, busyTimeoutMs) => {
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_rate_limit_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS login_rate_limit_entries (
      identity TEXT PRIMARY KEY,
      blocked_until INTEGER NOT NULL CHECK(blocked_until >= 0),
      last_failure_at INTEGER NOT NULL CHECK(last_failure_at >= 0)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS login_rate_limit_failures (
      id INTEGER PRIMARY KEY,
      identity TEXT NOT NULL REFERENCES login_rate_limit_entries(identity) ON DELETE CASCADE,
      failed_at INTEGER NOT NULL CHECK(failed_at >= 0)
    );

    CREATE INDEX IF NOT EXISTS login_rate_limit_failures_identity_time_idx
      ON login_rate_limit_failures(identity, failed_at);
  `);
  db.prepare("INSERT OR IGNORE INTO login_rate_limit_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  const schemaVersion = db.prepare("SELECT value FROM login_rate_limit_meta WHERE key = 'schema_version'").pluck().get();
  if (schemaVersion !== String(SCHEMA_VERSION)) {
    throw new Error(`Unsupported login rate-limit schema version: ${String(schemaVersion)}`);
  }
};

const migrateLegacyStore = (db, migration, config, now) => {
  let migrationWarning = null;
  const migrate = db.transaction(() => {
    const existingMarker = db.prepare("SELECT value FROM login_rate_limit_meta WHERE key = ?").pluck().get(LEGACY_MIGRATION_KEY);
    if (existingMarker !== undefined) {
      return;
    }

    if (migration.kind === "corrupt") {
      // Silently dropping possibly active blocks would weaken authentication. One bounded
      // block window is conservative, while the untouched JSON remains available to repair.
      db.prepare(`
        INSERT INTO login_rate_limit_entries (identity, blocked_until, last_failure_at)
        VALUES (?, ?, ?)
        ON CONFLICT(identity) DO UPDATE SET
          blocked_until = MAX(blocked_until, excluded.blocked_until),
          last_failure_at = MAX(last_failure_at, excluded.last_failure_at)
      `).run(GLOBAL_SAFETY_IDENTITY, now + config.blockMs, now);
      db.prepare("DELETE FROM login_rate_limit_failures WHERE identity = ?").run(GLOBAL_SAFETY_IDENTITY);
      db.prepare("INSERT INTO login_rate_limit_meta (key, value) VALUES (?, 'corrupt')").run(LEGACY_MIGRATION_KEY);
      migrationWarning = migration.reason;
      return;
    }

    if (migration.kind === "valid") {
      const upsertEntry = db.prepare(`
        INSERT INTO login_rate_limit_entries (identity, blocked_until, last_failure_at)
        VALUES (?, ?, ?)
        ON CONFLICT(identity) DO UPDATE SET
          blocked_until = MAX(blocked_until, excluded.blocked_until),
          last_failure_at = MAX(last_failure_at, excluded.last_failure_at)
      `);
      const insertFailure = db.prepare("INSERT INTO login_rate_limit_failures (identity, failed_at) VALUES (?, ?)");
      const cutoff = now - config.windowMs;
      for (const [identity, legacyState] of migration.entries) {
        const recentFailures = legacyState.failedAt.map((failedAt) => Math.min(failedAt, now)).filter((failedAt) => failedAt >= cutoff).sort((left, right) => left - right);
        let blockedUntil = legacyState.blockedUntil > now ? legacyState.blockedUntil : 0;
        if (blockedUntil === 0 && recentFailures.length >= config.maxFailures) {
          blockedUntil = now + config.blockMs;
        }
        if (blockedUntil === 0 && recentFailures.length === 0) {
          continue;
        }

        const lastFailureAt = Math.min(now, Math.max(legacyState.lastSeenAt, recentFailures.at(-1) ?? 0));
        upsertEntry.run(identity, blockedUntil, lastFailureAt);
        if (blockedUntil === 0) {
          for (const failedAt of recentFailures.slice(-(config.maxFailures - 1))) {
            insertFailure.run(identity, failedAt);
          }
        }
      }
    }

    db.prepare("INSERT INTO login_rate_limit_meta (key, value) VALUES (?, ?)").run(LEGACY_MIGRATION_KEY, migration.kind);
  });

  migrate.immediate();
  return migrationWarning;
};

const toStatus = (identity, blockedUntil, now) => ({
  identity,
  blocked: blockedUntil > now,
  blockedUntil,
  retryAfterSeconds: Math.max(0, Math.ceil((blockedUntil - now) / 1000)),
});

export const createLoginRateLimitStorage = (config) => {
  ensurePrivateDirectorySync(path.dirname(config.dbPath));
  ensurePrivateFileSync(config.dbPath);
  const migration = readLegacyMigration(config.legacyStorePath, config.maxIdentities);
  let db = null;

  try {
    db = new Database(config.dbPath, { timeout: config.busyTimeoutMs });
    ensurePrivateFileSync(config.dbPath);
    initializeSchema(db, config.busyTimeoutMs);
    ensurePrivateSqliteFiles(config.dbPath);
    const migrationWarning = migrateLegacyStore(db, migration, config, config.now());
    ensurePrivateSqliteFiles(config.dbPath);

    const selectEntry = db.prepare("SELECT blocked_until AS blockedUntil FROM login_rate_limit_entries WHERE identity = ?");
    const selectStatus = db.prepare(`
      SELECT identity, blocked_until AS blockedUntil
      FROM login_rate_limit_entries
      WHERE (identity = ? AND blocked_until > ?)
         OR identity = ?
         OR (
           identity = 'unknown'
           AND ? <> 'unknown'
           AND NOT EXISTS (SELECT 1 FROM login_rate_limit_entries WHERE identity = ?)
           AND (SELECT COUNT(*) FROM login_rate_limit_entries WHERE identity NOT IN ('unknown', ?)) >= ?
         )
      ORDER BY CASE WHEN identity = ? THEN 0 WHEN identity = ? THEN 1 ELSE 2 END
      LIMIT 1
    `);
    const countKnownEntries = db.prepare("SELECT COUNT(*) FROM login_rate_limit_entries WHERE identity NOT IN ('unknown', ?)").pluck();
    const pruneEntries = db.prepare("DELETE FROM login_rate_limit_entries WHERE blocked_until <= ? AND last_failure_at < ?");
    const deleteOldIdentityFailures = db.prepare("DELETE FROM login_rate_limit_failures WHERE identity = ? AND failed_at < ?");
    const insertEntry = db.prepare("INSERT OR IGNORE INTO login_rate_limit_entries (identity, blocked_until, last_failure_at) VALUES (?, 0, ?)");
    const updateEntryForFailure = db.prepare("UPDATE login_rate_limit_entries SET blocked_until = 0, last_failure_at = ? WHERE identity = ?");
    const insertFailure = db.prepare("INSERT INTO login_rate_limit_failures (identity, failed_at) VALUES (?, ?)");
    const countIdentityFailures = db.prepare("SELECT COUNT(*) FROM login_rate_limit_failures WHERE identity = ?").pluck();
    const activateBlock = db.prepare("UPDATE login_rate_limit_entries SET blocked_until = ?, last_failure_at = ? WHERE identity = ?");
    const deleteIdentityFailures = db.prepare("DELETE FROM login_rate_limit_failures WHERE identity = ?");
    const deleteEntry = db.prepare("DELETE FROM login_rate_limit_entries WHERE identity = ?");
    let mutationsUntilPrune = config.pruneInterval;

    const prune = (now) => {
      pruneEntries.run(now, now - config.entryTtlMs);
    };

    const resolveMutationIdentity = (requestedIdentity, now) => {
      if (requestedIdentity === "unknown" || selectEntry.get(requestedIdentity)) {
        return requestedIdentity;
      }
      if (countKnownEntries.get(GLOBAL_SAFETY_IDENTITY) < config.maxIdentities) {
        return requestedIdentity;
      }

      prune(now);
      return countKnownEntries.get(GLOBAL_SAFETY_IDENTITY) < config.maxIdentities ? requestedIdentity : "unknown";
    };

    // IMMEDIATE is essential here: every process acquires the write reservation before
    // observing the counter, so threshold decisions cannot be based on the same snapshot.
    const registerFailureTransaction = db.transaction((requestedIdentity, now) => {
      mutationsUntilPrune -= 1;
      if (mutationsUntilPrune <= 0) {
        prune(now);
        mutationsUntilPrune = config.pruneInterval;
      }

      const safetyBlock = selectEntry.get(GLOBAL_SAFETY_IDENTITY);
      if (safetyBlock?.blockedUntil > now) {
        return { ...toStatus(GLOBAL_SAFETY_IDENTITY, safetyBlock.blockedUntil, now), attemptsLeft: 0 };
      }

      const identity = resolveMutationIdentity(requestedIdentity, now);
      const existing = selectEntry.get(identity);
      if (existing?.blockedUntil > now) {
        return { ...toStatus(identity, existing.blockedUntil, now), attemptsLeft: 0 };
      }

      deleteOldIdentityFailures.run(identity, now - config.windowMs);
      insertEntry.run(identity, now);
      updateEntryForFailure.run(now, identity);
      insertFailure.run(identity, now);
      const failureCount = Number(countIdentityFailures.get(identity));
      if (failureCount >= config.maxFailures) {
        const blockedUntil = now + config.blockMs;
        activateBlock.run(blockedUntil, now, identity);
        deleteIdentityFailures.run(identity);
        return { ...toStatus(identity, blockedUntil, now), attemptsLeft: 0 };
      }

      return { ...toStatus(identity, 0, now), attemptsLeft: config.maxFailures - failureCount };
    });

    const clearTransaction = db.transaction((requestedIdentity, now) => {
      const identity = resolveMutationIdentity(requestedIdentity, now);
      deleteEntry.run(identity);
      return identity;
    });

    return {
      migrationWarning,
      verifyPrivateFiles() {
        ensurePrivateSqliteFiles(config.dbPath);
      },
      getStatus(identity, now = config.now()) {
        // Keep this path to one SELECT. In particular, an expired or active block must
        // not refresh a timestamp or trigger cleanup on every credential submission.
        const row = selectStatus.get(GLOBAL_SAFETY_IDENTITY, now, identity, identity, identity, GLOBAL_SAFETY_IDENTITY, config.maxIdentities, GLOBAL_SAFETY_IDENTITY, identity);
        return row ? toStatus(row.identity, row.blockedUntil, now) : toStatus(identity, 0, now);
      },
      registerFailure(identity, now = config.now()) {
        return registerFailureTransaction.immediate(identity, now);
      },
      clear(identity, now = config.now()) {
        return clearTransaction.immediate(identity, now);
      },
      close() {
        if (db.open) {
          db.close();
        }
      },
    };
  } catch (error) {
    if (db?.open) {
      db.close();
    }
    throw error;
  }
};
