// @vitest-environment node

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedSchema } from "@/test/isolated-schema";

async function integrationTests(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return integrationTests(path);
    return entry.name.endsWith(".integration.test.ts") ? [path] : [];
  }));
  return nested.flat();
}

describe("database test isolation", () => {
  it("gives every PostgreSQL integration test file schemas of its own, never public", async () => {
    const root = join(process.cwd(), "src");
    const owners = new Map<string, string>();
    for (const file of await integrationTests(root)) {
      const source = await readFile(file, "utf8");
      if (!source.includes("TEST_DATABASE_URL")) continue;
      const name = relative(root, file);
      // Every pool but the one that creates and drops the schemas carries a search_path; a bare pool lands in public.
      for (const [, variable, pool] of source.matchAll(/const (\w+) = (new Pool\(\{[^}]*\}\))/g)) {
        if (variable === "admin") continue;
        expect(pool, `${name}: ${pool}`).toContain("search_path");
      }
      const schemas = [...source.matchAll(/(?:const schema = |isolatedSchema\(databaseUrl, )"([a-z_0-9]+)"/g)].map((match) => match[1]!);
      expect(schemas.length, `${name} names no schema`).toBeGreaterThan(0);
      for (const schema of schemas) {
        expect(schema).not.toBe("public");
        expect(owners.get(schema) ?? name, `${schema} is shared`).toBe(name);
        owners.set(schema, name);
      }
    }
    expect(owners.size).toBeGreaterThanOrEqual(3);
  });

  it("refuses public and names that would need quoting", () => {
    for (const name of ["public", "Upper", "a-b", "x; DROP TABLE y", ""]) {
      expect(() => isolatedSchema("postgres://127.0.0.1/x_test", name)).toThrow(/Invalid test schema/);
    }
  });
});
