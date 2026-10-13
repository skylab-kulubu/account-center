import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { initialPreferenceScreen } from "./e2e-mock-core.mjs";

test("the mock core's first preference screen is the pinned core fixture", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../tests/fixtures/core-communication-preferences.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(initialPreferenceScreen(), fixture);
});
