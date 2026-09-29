import { androidAssetLinks, appAssociationResponse } from "@/server/well-known/app-association";

/** Read per request: the Mobile Lab's values arrive through the environment, not the build. */
export const dynamic = "force-dynamic";

export function GET() {
  return appAssociationResponse(androidAssetLinks(process.env));
}
