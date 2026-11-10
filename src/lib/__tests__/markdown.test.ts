import { describe, expect, it } from "vitest";

import { extractHeadings, parseMarkdownDocument, serializeMarkdownDocument, withSourceBlobSha } from "../markdown";

const SOURCE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const NEXT_SOURCE_SHA = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

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
    const markdown = `---\ntitle: API\ndescription: Endpoint docs\nexcludeFromAiPlaintext: true\n---\n# API`;
    const parsed = parseMarkdownDocument(markdown);

    expect(parsed.title).toBe("API");
    expect(parsed.description).toBe("Endpoint docs");
    expect(parsed.content.trim()).toBe("# API");
    expect(parsed.includeInPlaintextExport).toBe(false);
    expect(parsed.headings[0]).toEqual({ depth: 1, text: "API", slug: "api" });
  });

  it("serializes frontmatter only when metadata exists", () => {
    const withFrontmatter = serializeMarkdownDocument({
      title: "Guide",
      description: "How to",
      content: "# Body",
      includeInPlaintextExport: false,
    });

    expect(withFrontmatter.startsWith("---\n")).toBe(true);
    expect(withFrontmatter).toContain("title: Guide");
    expect(withFrontmatter).toContain("description: How to");
    expect(withFrontmatter).toContain("excludeFromAiPlaintext: true");

    const withoutFrontmatter = serializeMarkdownDocument({
      content: "# Body",
    });

    expect(withoutFrontmatter).toBe("# Body");
  });

  it("reads a recorded source version and ignores values that are not blob SHAs", () => {
    expect(parseMarkdownDocument(`---\nsourceBlobSha: ${SOURCE_SHA.toUpperCase()}\n---\nText`).sourceBlobSha).toBe(SOURCE_SHA);
    expect(parseMarkdownDocument("---\nsourceBlobSha: main\n---\nText").sourceBlobSha).toBeUndefined();
    expect(parseMarkdownDocument("Text").sourceBlobSha).toBeUndefined();
  });

  it("keeps front-matter keys it does not manage exactly as written when a page is saved", () => {
    const base = `---\n# Maintained by the docs team\ntitle: Old title\ndate: 2024-01-01\ntags:\n- setup\n- cli\norder: 3\n---\nOld body\n`;

    const saved = serializeMarkdownDocument({ title: "New title", description: "Fresh", content: "New body", includeInPlaintextExport: false }, base);

    expect(saved).toBe(`---\n# Maintained by the docs team\ntitle: New title\ndate: 2024-01-01\ntags:\n- setup\n- cli\norder: 3\ndescription: Fresh\nexcludeFromAiPlaintext: true\n---\nNew body\n`);
    expect(parseMarkdownDocument(saved)).toMatchObject({ title: "New title", description: "Fresh", content: "New body\n", includeInPlaintextExport: false });
  });

  it("removes managed keys that a save clears and keeps a recorded source version unless a new one is given", () => {
    const base = `---\ntitle: Titel\ndescription: >-\n  A long folded\n  description\nsourceBlobSha: ${SOURCE_SHA}\nweight: 2\n---\nText`;

    const kept = serializeMarkdownDocument({ title: "Titel", content: "Text" }, base);
    expect(kept).toBe(`---\ntitle: Titel\nsourceBlobSha: ${SOURCE_SHA}\nweight: 2\n---\nText\n`);

    const replaced = serializeMarkdownDocument({ title: "Titel", content: "Text", sourceBlobSha: NEXT_SOURCE_SHA }, base);
    expect(parseMarkdownDocument(replaced).sourceBlobSha).toBe(NEXT_SOURCE_SHA);
    expect(replaced).toContain("weight: 2");
  });

  it("records the source version without changing any other byte of the file", () => {
    const crlf = "---\r\ntitle: Startseite\r\nlayout: wide\r\n---\r\n\r\n## Hallo\r\nWelt";
    const stamped = withSourceBlobSha(crlf, SOURCE_SHA);

    expect(stamped).toBe(`---\r\ntitle: Startseite\r\nlayout: wide\r\nsourceBlobSha: ${SOURCE_SHA}\r\n---\r\n\r\n## Hallo\r\nWelt`);
    expect(parseMarkdownDocument(stamped).content).toBe(parseMarkdownDocument(crlf).content);

    const restamped = withSourceBlobSha(stamped, NEXT_SOURCE_SHA);
    expect(restamped).toBe(stamped.replace(SOURCE_SHA, NEXT_SOURCE_SHA));

    expect(withSourceBlobSha("No front matter yet", SOURCE_SHA)).toBe(`---\nsourceBlobSha: ${SOURCE_SHA}\n---\nNo front matter yet`);
  });
});
