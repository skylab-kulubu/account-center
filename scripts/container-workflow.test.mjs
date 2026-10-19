import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

/** The text of one top-level job, from its key to the next job's key. */
function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} is missing`);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

test("publishes only the single candidate image that passed every test and the container smoke test", () => {
  const image = job("image");
  assert.equal(workflow.match(/docker\/build-push-action@v7/g)?.length, 1);
  assert.match(image, /docker\/build-push-action@v7/);
  assert.match(image, /load: true/);
  assert.match(image, /push: false/);
  assert.match(image, /needs: \[scope, verify, browser, migration-compatibility\]/);
  assert.match(image, /!contains\(needs\.\*\.result, 'failure'\)/);
  assert.ok(workflow.indexOf("pnpm test:e2e") < workflow.indexOf("docker/build-push-action@v7"));
  assert.ok(image.indexOf("Smoke-test candidate image") < image.indexOf("docker push \"$target\""));
  assert.match(image, /EXPECTED_IMAGE_ID: \$\{\{ steps\.candidate\.outputs\.imageid \}\}/);
  assert.match(image, /source_image_id=.*docker image inspect/);
  assert.ok(image.indexOf("assert-retired-handoff.mjs") > image.indexOf("Smoke-test candidate image"));
  assert.ok(image.indexOf("assert-retired-handoff.mjs") < image.indexOf("docker push \"$target\""));
});

test("promotes the tested main image to production without rebuilding it", () => {
  const promote = job("promote");
  assert.match(promote, /needs\.scope\.outputs\.mode == 'tested'/);
  assert.match(promote, /source="\$IMAGE:main-\$\{TESTED_SHA::7\}"/);
  assert.match(promote, /imagetools create --prefer-index=false/);
  assert.match(promote, /test "\$\(digest "\$target"\)" = "\$source_digest"/);
  assert.doesNotMatch(promote, /build-push-action/);
});

test("triggers the production Dokploy deployment only after the gate passed", () => {
  const gate = job("gate");
  const deploy = job("deploy");
  assert.match(gate, /needs: \[scope, verify, browser, migration-compatibility, image, promote\]/);
  assert.match(deploy, /needs: gate/);
  assert.match(deploy, /github\.ref == 'refs\/heads\/production'/);
  assert.match(deploy, /DOKPLOY_DEPLOY_HOOK: \$\{\{ secrets\.DOKPLOY_DEPLOY_HOOK \}\}/);
  assert.match(deploy, /--user-agent 'DokployDeployHook\/1\.0'/);
  assert.match(deploy, /Dokploy did not accept the production deployment request/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});
