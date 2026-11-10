import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Directory of this run that every runtime path of every test file defaults into. */
    vickyTestRuntimeDir: string;
  }
}

const execFileAsync = promisify(execFile);

/** The platform's command that moves `target` to the trash (or recycle bin), or null when none is known. */
const trashCommand = (target: string): [string, string[]] | null => {
  switch (process.platform) {
    case "darwin":
      return ["/usr/bin/trash", [target]];
    case "linux":
      return ["gio", ["trash", target]];
    case "win32":
      return [
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${target.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`],
      ];
    default:
      return null;
  }
};

/**
 * Gives the run a directory of its own inside the project (`node_modules/.cache/vitest-runtime`,
 * on the project's drive) and moves it to the trash once every test file finished. Test data is
 * never deleted outright; when no trash command works the directory stays and its path is printed.
 */
export default function setup(project: TestProject): () => Promise<void> {
  const runtimeDir = path.join(project.config.root, "node_modules", ".cache", "vitest-runtime", `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
  project.provide("vickyTestRuntimeDir", runtimeDir);

  return async () => {
    if (!existsSync(runtimeDir)) {
      return;
    }

    const command = trashCommand(runtimeDir);
    try {
      if (!command) {
        throw new Error(`no trash command is known for ${process.platform}`);
      }
      await execFileAsync(command[0], command[1]);
    } catch (error: unknown) {
      console.warn(`[vitest] Could not move the test runtime directory to the trash (${error instanceof Error ? error.message : String(error)}); move ${runtimeDir} there yourself.`);
    }
  };
}
