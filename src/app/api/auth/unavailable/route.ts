import { ACCOUNT_ACCESS_RETRY_AFTER_SECONDS } from "@/server/access-gate/http";
import { errorSceneResponse } from "@/server/error-scene-html";

export const dynamic = "force-dynamic";

/** Where a page goes when the account gate cannot answer: the 503 scene, retried from the start. */
export function GET() {
  return errorSceneResponse("unavailable", 503, "/", {
    "Retry-After": String(ACCOUNT_ACCESS_RETRY_AFTER_SECONDS),
  });
}
