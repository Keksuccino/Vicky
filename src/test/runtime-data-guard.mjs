// Testing infrastructure shared by the Vitest setup and the fake GitHub preload of the real-server
// harness (see TESTING_GUIDELINES.md): finds runtime paths that would land in the project's real
// `data/` directory, where the developer's own settings, caches, and analytics live.
import { realpathSync } from "node:fs";
import path from "node:path";

import { resolveRuntimeStorageLayout } from "../lib/runtime-topology.mjs";

const realPathOrSelf = (target) => {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
};

const isInside = (directory, target) => {
  const relative = path.relative(directory, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * Runtime paths of `environment` (defaults applied exactly as a Vicky process applies them) that
 * lie inside `<cwd>/data`. An unset variable counts with its default, which is inside `data/`.
 *
 * @param {Record<string, string | undefined>} [environment]
 * @param {string} [cwd]
 * @returns {string[]}
 */
export function findRuntimePathsInDataDirectory(environment = process.env, cwd = process.cwd()) {
  const dataDirectory = path.resolve(cwd, "data");
  const dataDirectories = [...new Set([dataDirectory, realPathOrSelf(dataDirectory)])];
  const layout = resolveRuntimeStorageLayout(environment, cwd);
  const snapshotDirectory = environment.WIKI_DOCS_SNAPSHOT_DIR?.trim();
  const candidates = [
    ...layout.directories,
    ...layout.sensitiveFiles,
    layout.obsoleteTranslationCacheDir,
    layout.ownerFilePath,
    layout.assignmentFilePath,
    ...(snapshotDirectory ? [path.resolve(cwd, snapshotDirectory)] : []),
  ];

  return [...new Set(candidates)].filter((candidate) => dataDirectories.some((directory) => isInside(directory, candidate) || isInside(directory, realPathOrSelf(candidate))));
}
