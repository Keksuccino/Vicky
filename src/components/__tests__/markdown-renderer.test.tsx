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
});
