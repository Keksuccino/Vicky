import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";

import { config } from "../../../middleware";

const runsMiddleware = (path: string): boolean => unstable_doesMiddlewareMatch({ config, url: `http://localhost${path}` });

describe("middleware matcher", () => {
  it.each(["/admin", "/admin/settings", "/admin/login", "/editor", "/api/admin/settings", "/api/admin/docs"])("guards %s", (path) => {
    expect(runsMiddleware(path)).toBe(true);
  });

  it.each(["/docs", "/docs/en-US/home", "/docs/en-US/guide/setup?raw=1", "/api/docs/tree", "/api/docs/page?slug=home"])("leaves public docs traffic at %s alone", (path) => {
    expect(runsMiddleware(path)).toBe(false);
  });
});
