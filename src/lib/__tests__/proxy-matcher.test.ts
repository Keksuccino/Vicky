import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";

import { config } from "../../proxy";

// Next 16 still names this testing helper after middleware; it evaluates the proxy matcher the same way.
const runsProxy = (path: string): boolean => unstable_doesMiddlewareMatch({ config, url: `http://localhost${path}` });

describe("proxy matcher", () => {
  it.each(["/admin", "/admin/settings", "/admin/login", "/editor", "/api/admin/settings", "/api/admin/docs"])("guards %s", (path) => {
    expect(runsProxy(path)).toBe(true);
  });

  it.each(["/docs", "/docs/en-US/home", "/docs/en-US/guide/setup?raw=1", "/api/docs/tree", "/api/docs/page?slug=home"])("leaves public docs traffic at %s alone", (path) => {
    expect(runsProxy(path)).toBe(false);
  });
});
