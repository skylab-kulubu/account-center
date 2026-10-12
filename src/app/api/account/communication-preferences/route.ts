import type { NextRequest } from "next/server";
import {
  readCommunicationPreferences,
  updateCommunicationPreferences,
} from "@/server/communication-preferences/http";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return readCommunicationPreferences(request);
}

export function PUT(request: NextRequest) {
  return updateCommunicationPreferences(request);
}
