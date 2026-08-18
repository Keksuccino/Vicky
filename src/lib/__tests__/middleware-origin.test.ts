import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { middleware } from "../../../middleware";

describe("middleware redirect origin", () => {
  it("uses a relative login redirect that cannot be poisoned by untrusted forwarding", async () => {
    const request = new NextRequest("https://direct.example.com/admin/settings?tab=domain", {
      headers: { host: "direct.example.com", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" },
    });

    const response = await middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/admin/login?next=%2Fadmin%2Fsettings%3Ftab%3Ddomain");
  });
});
