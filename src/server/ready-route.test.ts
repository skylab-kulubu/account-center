import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/ready/route";

const readyMocks = vi.hoisted(() => ({
  gateReady: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => ({ accountAccess: { ready: readyMocks.gateReady } }),
}));
vi.mock("@/server/db/pool", () => ({
  getDatabasePool: () => ({ query: readyMocks.query }),
}));

describe("readiness route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readyMocks.gateReady.mockResolvedValue(true);
    readyMocks.query.mockResolvedValue({
      rows: [{ sessions_ready: true, controls_ready: true, native_ready: true, actions_ready: true, migrations_ready: true }],
    });
  });

  it("reports ready only after config, database, and expected migrations are available", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", service: "account-center" });
    expect(readyMocks.query).toHaveBeenCalledWith(
      expect.stringContaining("account_center_schema_migrations"),
      [[
        "0001_bff_web_sessions.sql",
        "0002_auth_security_controls.sql",
        "0003_native_handoff.sql",
        "0004_account_action_results.sql",
      ]],
    );
  });

  it.each([
    { sessions_ready: false, controls_ready: true, native_ready: true, actions_ready: true, migrations_ready: true },
    { sessions_ready: true, controls_ready: false, native_ready: true, actions_ready: true, migrations_ready: true },
    { sessions_ready: true, controls_ready: true, native_ready: false, actions_ready: true, migrations_ready: true },
    { sessions_ready: true, controls_ready: true, native_ready: true, actions_ready: false, migrations_ready: true },
    { sessions_ready: true, controls_ready: true, native_ready: true, actions_ready: true, migrations_ready: false },
  ])("reports not ready for an incomplete schema", async (row) => {
    readyMocks.query.mockResolvedValue({ rows: [row] });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready", service: "account-center" });
  });

  it("reports not ready when PostgreSQL validation fails", async () => {
    readyMocks.query.mockRejectedValue(new Error("database unavailable"));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(readyMocks.gateReady).not.toHaveBeenCalled();
  });

  it("reports not ready when the access-gate contract is unavailable", async () => {
    readyMocks.gateReady.mockResolvedValue(false);

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready", service: "account-center" });
  });
});
