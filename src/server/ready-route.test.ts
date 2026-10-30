import { beforeEach, describe, expect, it, vi } from "vitest";

let GET: (request: Request) => Promise<Response>;

const readyMocks = vi.hoisted(() => ({
  gateReady: vi.fn(),
  query: vi.fn(),
  mainQuery: vi.fn(),
}));

vi.mock("@/server/auth/services", () => ({
  getAuthServices: () => ({ accountAccess: { ready: readyMocks.gateReady } }),
}));
vi.mock("@/server/db/pool", () => ({
  getDatabasePool: () => ({ query: readyMocks.mainQuery }),
  getReadinessPool: () => ({ query: readyMocks.query }),
}));

function probe(query = "") {
  return new Request(`http://127.0.0.1:3000/api/ready${query}`);
}

describe("readiness route", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Each test is a fresh process: the route remembers whether the gate was ever ready.
    vi.resetModules();
    ({ GET } = await import("@/app/api/ready/route"));
    readyMocks.gateReady.mockResolvedValue(true);
    readyMocks.query.mockResolvedValue({
      rows: [{ sessions_ready: true, controls_ready: true, actions_ready: true, deletion_ready: true, sudo_ready: true, rotation_ready: true, notices_ready: true, migrations_ready: true }],
    });
  });

  it("reports ready only after config, database, and expected migrations are available", async () => {
    const response = await GET(probe());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", service: "account-center" });
    expect(readyMocks.query).toHaveBeenCalledWith(
      expect.stringContaining("account_center_schema_migrations"),
      [[
        "0001_bff_web_sessions.sql",
        "0002_auth_security_controls.sql",
        "0003_native_handoff.sql",
        "0004_account_action_results.sql",
        "0005_account_deletion_intents.sql",
        "0006_account_sudo.sql",
        "0007_account_deletion_confirmations.sql",
        "0009_account_notice_dismissals.sql",
        "0010_account_session_rotation_salt.sql",
      ]],
    );
    expect(readyMocks.query.mock.calls[0]![0]).toContain("to_regclass('public.account_notice_dismissals')");
    expect(readyMocks.query.mock.calls[0]![0]).toContain("column_name = 'rotation_salt'");
    expect(readyMocks.query.mock.calls[0]![0]).toContain("count(*) = 9");
  });

  it("neither checks the retired native handoff tables nor requires their drop migration", async () => {
    const response = await GET(probe());

    expect(response.status).toBe(200);
    const [sql, [requiredMigrations]] = readyMocks.query.mock.calls[0] as [string, [string[]]];
    expect(sql).not.toContain("account_native_");
    expect(requiredMigrations).not.toContain("0008_drop_native_handoff.sql");
  });

  it.each([
    { sessions_ready: false, controls_ready: true, actions_ready: true, deletion_ready: true, sudo_ready: true, rotation_ready: true, notices_ready: true, migrations_ready: true },
    { sessions_ready: true, controls_ready: false, actions_ready: true, deletion_ready: true, sudo_ready: true, rotation_ready: true, notices_ready: true, migrations_ready: true },
    { sessions_ready: true, controls_ready: true, actions_ready: false, deletion_ready: true, sudo_ready: true, rotation_ready: true, notices_ready: true, migrations_ready: true },
    { sessions_ready: true, controls_ready: true, actions_ready: true, deletion_ready: false, sudo_ready: true, rotation_ready: true, notices_ready: true, migrations_ready: true },
    { sessions_ready: true, controls_ready: true, actions_ready: true, deletion_ready: true, sudo_ready: false, rotation_ready: true, notices_ready: true, migrations_ready: true },
    { sessions_ready: true, controls_ready: true, actions_ready: true, deletion_ready: true, sudo_ready: true, rotation_ready: true, notices_ready: true, migrations_ready: false },
    { sessions_ready: true, controls_ready: true, actions_ready: true, deletion_ready: true, sudo_ready: true, rotation_ready: true, notices_ready: false, migrations_ready: true },
    { sessions_ready: true, controls_ready: true, actions_ready: true, deletion_ready: true, sudo_ready: true, rotation_ready: false, notices_ready: true, migrations_ready: true },
  ])("reports not ready for an incomplete schema", async (row) => {
    readyMocks.query.mockResolvedValue({ rows: [row] });

    const response = await GET(probe());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready", service: "account-center" });
  });

  it("reports not ready when PostgreSQL validation fails", async () => {
    readyMocks.query.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(probe());

    expect(response.status).toBe(503);
    expect(readyMocks.gateReady).not.toHaveBeenCalled();
  });

  it("leaves the access gate out for the container health check once the gate was ready, so a Redis outage restarts no task", async () => {
    expect((await GET(probe("?gate=skip"))).status).toBe(200);
    readyMocks.gateReady.mockClear();
    readyMocks.gateReady.mockResolvedValue(false);

    const response = await GET(probe("?gate=skip"));

    expect(response.status).toBe(200);
    expect(readyMocks.gateReady).not.toHaveBeenCalled();
  });

  it("does not let a new task that never reached the gate pass the container health check", async () => {
    readyMocks.gateReady.mockResolvedValue(false);

    for (let i = 0; i < 2; i++) {
      expect((await GET(probe("?gate=skip"))).status).toBe(503);
    }
    expect(readyMocks.gateReady).toHaveBeenCalledTimes(2);

    readyMocks.gateReady.mockResolvedValueOnce(true);
    expect((await GET(probe())).status).toBe(200);
    expect((await GET(probe("?gate=skip"))).status).toBe(200);
  });

  it("reads PostgreSQL on readiness's own connection, never the request pool", async () => {
    await GET(probe("?gate=skip"));
    await GET(probe());

    expect(readyMocks.query).toHaveBeenCalled();
    expect(readyMocks.mainQuery).not.toHaveBeenCalled();
  });

  it("lets callers arriving while the schema query runs share it, so the public route never queues on the one connection", async () => {
    let answer!: (value: unknown) => void;
    readyMocks.query.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));

    const responses = Promise.all(Array.from({ length: 5 }, (_, i) => GET(probe(i % 2 ? "?gate=skip" : ""))));
    answer({
      rows: [{ sessions_ready: true, controls_ready: true, actions_ready: true, deletion_ready: true, sudo_ready: true, rotation_ready: true, notices_ready: true, migrations_ready: true }],
    });

    expect((await responses).map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(readyMocks.query).toHaveBeenCalledOnce();
  });

  it("reuses the schema answer for a second, a failure too, then asks again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      readyMocks.query.mockRejectedValueOnce(new Error("database unavailable"));
      expect((await GET(probe())).status).toBe(503);
      vi.advanceTimersByTime(900);
      expect((await GET(probe())).status).toBe(503);
      expect(readyMocks.query).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(200);
      expect((await GET(probe())).status).toBe(200);
      expect((await GET(probe())).status).toBe(200);
      expect(readyMocks.query).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reports not ready for the container health check when PostgreSQL validation fails", async () => {
    readyMocks.query.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(probe("?gate=skip"));

    expect(response.status).toBe(503);
  });

  it.each(["?gate=", "?gate=off", "?gate=SKIP"])("checks the access gate for any other gate value (%s)", async (query) => {
    readyMocks.gateReady.mockResolvedValue(false);

    const response = await GET(probe(query));

    expect(response.status).toBe(503);
    expect(readyMocks.gateReady).toHaveBeenCalledOnce();
  });

  it("reports not ready when the access-gate contract is unavailable", async () => {
    readyMocks.gateReady.mockResolvedValue(false);

    const response = await GET(probe());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready", service: "account-center" });
  });
});
