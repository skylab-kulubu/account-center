import { describe, expect, it } from "vitest";
import { databasePoolMax } from "@/server/db/pool-size";

describe("database pool size", () => {
  it("keeps the old 10 connections when DATABASE_POOL_MAX is unset or blank", () => {
    expect(databasePoolMax(undefined)).toBe(10);
    expect(databasePoolMax("  ")).toBe(10);
  });

  it("takes the size from DATABASE_POOL_MAX", () => {
    expect(databasePoolMax("4")).toBe(4);
    expect(databasePoolMax(" 25 ")).toBe(25);
  });

  it.each(["0", "101", "-1", "2.5", "ten", "1e1"])("rejects %s", (value) => {
    expect(() => databasePoolMax(value)).toThrow("DATABASE_POOL_MAX");
  });
});
