import "server-only";

import {
  diffClubProfilePatch,
  parseClubProfileInput,
  validateClubProfilePicture,
} from "@/server/club-profile/validation";
import { CoreProfileUnauthorizedError } from "@/server/core/profile-client";
import type { CoreProfile, CoreProfileClient } from "@/server/core/profile-client";
import type { AccountReadService } from "@/server/keycloak-account/service";

/**
 * Club profile for the signed-in person, read and written through core with
 * the session's own user token (audience `core`, no core roles). Names are
 * deliberately absent: they are Keycloak-owned and change through the identity
 * page; phone is read-only until phone verification exists.
 */
export type ClubProfileView = {
  skyNumber: string | null;
  studentCardLinked: boolean;
  schoolEmail: string | null;
  phone: string | null;
  university: string | null;
  faculty: string | null;
  department: string | null;
  linkedin: string | null;
  profilePictureUrl: string | null;
  updatedAt: string | null;
};

export type ClubProfileUpdate = { profile: CoreProfile; changed: boolean };

type SessionIdentity = { id: string; subject: string };
type TokenSource = Pick<AccountReadService, "accessToken">;

/** The browser-safe projection: no identifiers, no shadow names, no media ids. */
export function toClubProfileView(profile: CoreProfile): ClubProfileView {
  return {
    skyNumber: profile.skyNumber,
    studentCardLinked: profile.studentCardLinked,
    schoolEmail: profile.schoolEmail,
    phone: profile.phone,
    university: profile.university,
    faculty: profile.faculty,
    department: profile.department,
    linkedin: profile.linkedin,
    profilePictureUrl: profile.profilePictureUrl,
    updatedAt: profile.updatedAt,
  };
}

export class ClubProfileService {
  constructor(
    private readonly core: CoreProfileClient,
    private readonly tokens: TokenSource,
  ) {}

  /**
   * Runs one core operation with the session's validated token. A core 401
   * means the bearer was not accepted (expired between validation and use, or
   * refreshed by a racing request), so the operation is retried exactly once
   * with a force-refreshed token; every other failure surfaces unchanged.
   */
  async #withToken<T>(session: SessionIdentity, operation: (accessToken: string) => Promise<T>) {
    const accessToken = await this.tokens.accessToken(session);
    try {
      return await operation(accessToken);
    } catch (error) {
      if (!(error instanceof CoreProfileUnauthorizedError)) throw error;
      return operation(await this.tokens.accessToken(session, { forceRefresh: true }));
    }
  }

  /** The caller's full core profile; callers project it with `toClubProfileView` before it reaches a browser. */
  read(session: SessionIdentity): Promise<CoreProfile> {
    return this.#withToken(session, (accessToken) => this.core.getMe(accessToken));
  }

  /**
   * Validates the browser input, reads the current core profile and forwards
   * only the members that differ. An unchanged form is reported as such
   * without a core write.
   */
  async update(session: SessionIdentity, body: unknown): Promise<ClubProfileUpdate> {
    const input = parseClubProfileInput(body);
    return this.#withToken(session, async (accessToken) => {
      const current = await this.core.getMe(accessToken);
      const patch = diffClubProfilePatch(current, input);
      if (Object.keys(patch).length === 0) return { profile: current, changed: false };
      return { profile: await this.core.patchMe(accessToken, patch), changed: true };
    });
  }

  /** Sniffs and bounds the bytes, uploads them under the sniffed type, then re-reads the profile. */
  async uploadPicture(session: SessionIdentity, bytes: Uint8Array): Promise<CoreProfile> {
    const { contentType } = validateClubProfilePicture(bytes);
    return this.#withToken(session, async (accessToken) => {
      await this.core.uploadProfilePicture(accessToken, { bytes, contentType });
      return this.core.getMe(accessToken);
    });
  }

  removePicture(session: SessionIdentity): Promise<CoreProfile> {
    return this.#withToken(session, async (accessToken) => {
      await this.core.deleteProfilePicture(accessToken);
      return this.core.getMe(accessToken);
    });
  }
}

type ClubProfileDependencies = {
  account: TokenSource;
  coreProfile: CoreProfileClient | null;
};

const instances = new WeakMap<ClubProfileDependencies, ClubProfileService | null>();

/**
 * The club-profile service for a services registry, or `null` when
 * `CORE_API_URL` is unset and club-profile features are off. Memoized per
 * registry so routes and pages share one instance.
 */
export function clubProfileServiceFor(services: ClubProfileDependencies): ClubProfileService | null {
  let instance = instances.get(services);
  if (instance === undefined) {
    instance = services.coreProfile ? new ClubProfileService(services.coreProfile, services.account) : null;
    instances.set(services, instance);
  }
  return instance;
}
