import { describe, expect, it } from "vitest";

import { AI_PLAINTEXT_EXPORT_PATH, renderPlaintextDocsExport } from "../docs-plaintext";

describe("plaintext docs export", () => {
  it("renders included pages with explicit start and end markers", () => {
    const rendered = renderPlaintextDocsExport("https://docs.example.com", [
      {
        path: "home.md",
        slug: "home",
        title: "Home",
        markdown: "# Home\n\nWelcome.",
        includeInPlaintextExport: true,
      },
      {
        path: "hidden.md",
        slug: "hidden",
        title: "Hidden",
        markdown: "# Hidden\n\nSecret.",
        includeInPlaintextExport: false,
      },
    ]);

    expect(rendered).toContain("BEGIN PAGE: https://docs.example.com/docs/home");
    expect(rendered).toContain("# Home\n\nWelcome.");
    expect(rendered).toContain("END PAGE: https://docs.example.com/docs/home");
    expect(rendered).not.toContain("https://docs.example.com/docs/hidden");
  });

  it("renders a fallback message when all pages are excluded", () => {
    const rendered = renderPlaintextDocsExport("https://docs.example.com", [
      {
        path: "hidden.md",
        slug: "hidden",
        title: "Hidden",
        markdown: "# Hidden",
        includeInPlaintextExport: false,
      },
    ]);

    expect(rendered).toContain(`No docs pages are currently included in ${AI_PLAINTEXT_EXPORT_PATH}.`);
  });
});
