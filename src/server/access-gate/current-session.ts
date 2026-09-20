import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/server/auth/http";
import { getAuthServices } from "@/server/auth/services";

export const currentAccountSession = cache(async () => {
  const services = getAuthServices();
  const handle = (await cookies()).get(SESSION_COOKIE)?.value;
  return services.sessionAccess.authenticate(handle);
});
