import { describe, expect, it } from "vitest";

import { normalizeStartPage, startPageToDocsHref } from "../start-page";

describe("start page helpers", () => {
  it("normalizes docs-relative paths", () => {
    expect(normalizeStartPage("/docs/home")).toBe("/home");
    expect(normalizeStartPage("home.md")).toBe("/home");
  });

  it("normalizes full URLs including scheme-less domains", () => {
    expect(normalizeStartPage("https://example.com/docs/getting-started")).toBe("/getting-started");
    expect(normalizeStartPage("example.com/docs/getting-started")).toBe("/getting-started");
  });

  it("creates docs href from normalized start page", () => {
    expect(startPageToDocsHref("example.com/docs/home")).toBe("/docs/home");
  });
});
