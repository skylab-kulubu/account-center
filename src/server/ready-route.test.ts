import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/ready/route";

const readyMocks = vi.hoisted(() => ({
  config: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/server/auth/config", () => ({ getAuthConfig: readyMocks.config }));
vi.mock("@/server/db/pool", () => ({
  getDatabasePool: () => ({ query: readyMocks.query }),
}));

describe("readiness route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readyMocks.config.mockReturnValue({});
    readyMocks.query.mockResolvedValue({
      rows: [{ sessions_ready: true, controls_ready: true, migrations_ready: true }],
    });
  });

  it("reports ready only after config, database, and expected migrations are available", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", service: "account-center" });
    expect(readyMocks.query).toHaveBeenCalledWith(
      expect.stringContaining("account_center_schema_migrations"),
      [["0001_bff_web_sessions.sql", "0002_auth_security_controls.sql"]],
    );
  });

  it.each([
    { sessions_ready: false, controls_ready: true, migrations_ready: true },
    { sessions_ready: true, controls_ready: false, migrations_ready: true },
    { sessions_ready: true, controls_ready: true, migrations_ready: false },
  ])("reports not ready for an incomplete schema", async (row) => {
    readyMocks.query.mockResolvedValue({ rows: [row] });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready", service: "account-center" });
  });

  it("reports not ready when config or PostgreSQL validation fails", async () => {
    readyMocks.config.mockImplementation(() => {
      throw new Error("invalid environment");
    });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(readyMocks.query).not.toHaveBeenCalled();
  });
});
