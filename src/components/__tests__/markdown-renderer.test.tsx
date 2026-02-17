// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownRenderer } from "../markdown-renderer";

describe("MarkdownRenderer", () => {
  it("keeps heading ids compatible with hash links", () => {
    render(<MarkdownRenderer content="## Adding Elements to Layouts" />);

    const heading = screen.getByRole("heading", {
      level: 2,
      name: /Adding Elements to Layouts/i,
    });

    expect(heading.getAttribute("id")).toBe("adding-elements-to-layouts");
  });

  it("renders single newlines as line breaks", () => {
    const { container } = render(<MarkdownRenderer content={"First line\nSecond line"} />);

    expect(container.querySelector("br")).toBeTruthy();
  });

  it("does not render an empty first line in GitHub alert blocks", () => {
    const { container } = render(<MarkdownRenderer content={"> [!INFO]\n> First line\n> Second line"} />);

    const alertParagraph = container.querySelector(".md-alert p");
    expect(alertParagraph).toBeTruthy();
    expect(alertParagraph?.innerHTML.startsWith("<br")).toBe(false);
  });

  it("rewrites root short links to docs paths", () => {
    render(<MarkdownRenderer content="[Home](/home)" />);

    const link = screen.getByRole("link", { name: "Home" });
    expect(link.getAttribute("href")).toBe("/docs/home");
  });

  it("does not rewrite links that already target nested paths", () => {
    render(<MarkdownRenderer content="[Nested](/docs/home)\n\n[Deep](/foo/bar)" />);

    const nestedLink = screen.getByRole("link", { name: "Nested" });
    const deepLink = screen.getByRole("link", { name: "Deep" });

    expect(nestedLink.getAttribute("href")).toBe("/docs/home");
    expect(deepLink.getAttribute("href")).toBe("/foo/bar");
  });

  it("renders copy buttons only for fenced code blocks", () => {
    render(<MarkdownRenderer content={"```ts\nconst value = 42;\n```\n\nInline `const quick = true` code."} />);

    const copyButtons = screen.getAllByRole("button", { name: /copy code/i });
    expect(copyButtons).toHaveLength(1);
  });
});
