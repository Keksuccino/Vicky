import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const APP_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const LAYOUT_SOURCE = readFileSync(new URL("../layout.tsx", import.meta.url), "utf8");
const GLOBAL_CSS_SOURCE = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

describe("font wiring", () => {
  it("keeps every local font source present with exact filename casing", () => {
    const references = [...LAYOUT_SOURCE.matchAll(/path:\s*["']([^"']+\.(?:woff2?|ttf|otf|eot))["']/gi)].map((match) => match[1]);

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      const fontPath = resolve(APP_DIRECTORY, reference);
      expect(statSync(fontPath).isFile()).toBe(true);
      expect(readdirSync(dirname(fontPath))).toContain(basename(fontPath));
    }
  });

  it("uses only font custom properties defined by the layout or stylesheet", () => {
    const layoutDefinitions = [...LAYOUT_SOURCE.matchAll(/variable:\s*["'](--font-[\w-]+)["']/g)].map((match) => match[1]);
    const stylesheetDefinitions = [...GLOBAL_CSS_SOURCE.matchAll(/(--font-[\w-]+)\s*:/g)].map((match) => match[1]);
    const definitions = new Set([...layoutDefinitions, ...stylesheetDefinitions]);
    const references = new Set([...GLOBAL_CSS_SOURCE.matchAll(/var\(\s*(--font-[\w-]+)/g)].map((match) => match[1]));

    expect([...references].filter((reference) => !definitions.has(reference))).toEqual([]);
  });

  it("keeps package font URLs resolvable", () => {
    const require = createRequire(import.meta.url);
    const packageCssPath = require.resolve("@fontsource/material-symbols-outlined/400.css");
    const packageCss = readFileSync(packageCssPath, "utf8");
    const references = [...packageCss.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1].replace(/["']/g, ""));

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      const fontPath = resolve(dirname(packageCssPath), reference);
      expect(statSync(fontPath).isFile()).toBe(true);
      expect(readdirSync(dirname(fontPath))).toContain(basename(fontPath));
    }
  });
});
