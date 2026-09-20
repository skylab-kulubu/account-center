import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/container.yml", import.meta.url),
  "utf8",
);

test("publishes only the single candidate image that passed browser and container verification", () => {
  assert.equal(workflow.match(/docker\/build-push-action@v7/g)?.length, 1);
  assert.match(workflow, /load: true/);
  assert.match(workflow, /push: false/);
  assert.ok(workflow.indexOf("pnpm test:e2e") < workflow.indexOf("docker/build-push-action@v7"));
  assert.ok(workflow.indexOf("Smoke-test candidate image") < workflow.indexOf("docker push \"$target\""));
  assert.match(workflow, /EXPECTED_IMAGE_ID: \$\{\{ steps\.candidate\.outputs\.imageid \}\}/);
  assert.match(workflow, /source_image_id=.*docker image inspect/);
  assert.ok(workflow.indexOf("pnpm test:handoff-response") < workflow.indexOf("docker push \"$target\""));
});
