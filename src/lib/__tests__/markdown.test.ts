import { describe, expect, it } from "vitest";

import { extractHeadings, parseMarkdownDocument, serializeMarkdownDocument } from "../markdown";

describe("markdown helpers", () => {
  it("extracts headings and de-duplicates slugs", () => {
    const markdown = `# Intro\n\n## Setup\n## Setup\n\n\`\`\`md\n# Ignored\n\`\`\``;

    const headings = extractHeadings(markdown);

    expect(headings).toEqual([
      { depth: 1, text: "Intro", slug: "intro" },
      { depth: 2, text: "Setup", slug: "setup" },
      { depth: 2, text: "Setup", slug: "setup-1" },
    ]);
  });

  it("keeps underscore segments in slugs to match rendered heading ids", () => {
    const markdown = "## Previous Track (audio_previous_track)";
    const headings = extractHeadings(markdown);

    expect(headings).toEqual([
      {
        depth: 2,
        text: "Previous Track (audio_previous_track)",
        slug: "previous-track-audio_previous_track",
      },
    ]);
  });

  it("parses frontmatter and content", () => {
    const markdown = `---\ntitle: API\ndescription: Endpoint docs\n---\n# API`;
    const parsed = parseMarkdownDocument(markdown);

    expect(parsed.title).toBe("API");
    expect(parsed.description).toBe("Endpoint docs");
    expect(parsed.content.trim()).toBe("# API");
    expect(parsed.headings[0]).toEqual({ depth: 1, text: "API", slug: "api" });
  });

  it("serializes frontmatter only when metadata exists", () => {
    const withFrontmatter = serializeMarkdownDocument({
      title: "Guide",
      description: "How to",
      content: "# Body",
    });

    expect(withFrontmatter.startsWith("---\n")).toBe(true);
    expect(withFrontmatter).toContain("title: Guide");
    expect(withFrontmatter).toContain("description: How to");

    const withoutFrontmatter = serializeMarkdownDocument({
      content: "# Body",
    });

    expect(withoutFrontmatter).toBe("# Body");
  });
});
