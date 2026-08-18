import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ getStore: vi.fn() }));

vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));

import { handleIconRequest } from "@/app/api/public/icon/shared";

describe("public icon redirect origin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStore.mockResolvedValue({
      settings: {
        docsIcon: { png16Url: "/assets/icon.png", png32Url: "", png180Url: "" },
        domain: { customDomain: "canonical.example.com" },
      },
    });
  });

  it("resolves a relative icon against the canonical domain instead of spoofed forwarding", async () => {
    const request = new NextRequest("https://internal.example/api/public/icon/16", {
      headers: { host: "internal.example", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" },
    });

    const response = await handleIconRequest(request, "16");

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://canonical.example.com/assets/icon.png");
  });
});
