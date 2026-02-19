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

  it.each([
    ["{.is-info}", "info"],
    ["{.is-warning}", "warning"],
    ["{.is-success}", "success"],
    ["{.is-danger}", "error"],
  ])("supports WikiJS alert markers for %s", (marker, expectedVariant) => {
    const content = `> Wiki-style alert body\n${marker}`;
    const { container } = render(<MarkdownRenderer content={content} />);

    const alert = container.querySelector(`.md-alert-${expectedVariant}`);
    expect(alert).toBeTruthy();
    expect(screen.queryByText(marker)).toBeNull();
  });

  it("supports WikiJS markers when parsed as a sibling paragraph", () => {
    const content = "> Wiki alert with explicit continuation\n>\n{.is-warning}";
    const { container } = render(<MarkdownRenderer content={content} />);

    const alert = container.querySelector(".md-alert-warning");
    expect(alert).toBeTruthy();
    expect(screen.queryByText("{.is-warning}")).toBeNull();
  });

  it("rewrites root-relative links to docs paths, including nested paths", () => {
    render(<MarkdownRenderer content={"[Home](/home)\n\n[Deep](/guides/setup?mode=full#install)\n\n[Root](/)"} />);

    const link = screen.getByRole("link", { name: "Home" });
    const deepLink = screen.getByRole("link", { name: "Deep" });
    const rootLink = screen.getByRole("link", { name: "Root" });

    expect(link.getAttribute("href")).toBe("/docs/home");
    expect(deepLink.getAttribute("href")).toBe("/docs/guides/setup?mode=full#install");
    expect(rootLink.getAttribute("href")).toBe("/docs");
  });

  it("does not rewrite links that target reserved app routes or existing docs paths", () => {
    render(<MarkdownRenderer content="[Docs](/docs/home)\n\n[API](/api/docs/page)\n\n[Admin](/admin/login)" />);

    const docsLink = screen.getByRole("link", { name: "Docs" });
    const apiLink = screen.getByRole("link", { name: "API" });
    const adminLink = screen.getByRole("link", { name: "Admin" });

    expect(docsLink.getAttribute("href")).toBe("/docs/home");
    expect(apiLink.getAttribute("href")).toBe("/api/docs/page");
    expect(adminLink.getAttribute("href")).toBe("/admin/login");
  });

  it("falls back to a safe hash for protocol-relative links", () => {
    render(<MarkdownRenderer content="[Unsafe](//example.com/phishing)" />);

    const unsafeLink = screen.getByRole("link", { name: "Unsafe" });
    expect(unsafeLink.getAttribute("href")).toBe("#");
  });

  it("renders copy buttons only for fenced code blocks", () => {
    render(<MarkdownRenderer content={"```ts\nconst value = 42;\n```\n\nInline `const quick = true` code."} />);

    const copyButtons = screen.getAllByRole("button", { name: /copy code/i });
    expect(copyButtons).toHaveLength(1);
  });
});
