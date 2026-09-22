import "server-only";

import {
  applicationCatalog,
  keycloakInternalClientIds,
  siteClientNames,
  siteRoleCatalog,
} from "@/config/permission-catalog";
import type { ApplicationDefinition, PermissionLabel } from "@/config/permission-catalog";
import type { SkyAuthorization } from "@/server/keycloak-account/access-token";
import type { AccountGroup } from "@/server/keycloak-account/types";

/**
 * Read model of the Permissions view ("Yetkilerim"). It is derived from two
 * read-only sources: the person's Keycloak groups
 * (`GET /account/groups?briefRepresentation=false`) and the `sky_authorization`
 * claim of the validated user token. Realm roles are never part of either
 * source, and nothing here is used to authorize anything inside Account Center.
 */

export type TeamRole = "member" | "leader" | "coordinator";

export type TeamMembership = Readonly<{
  /** Path of the team group itself; a leader/coordinator subgroup collapses onto its team. */
  path: string;
  /** `display_name_tr` of the team group, else the last path segment. */
  name: string;
  role: TeamRole;
  roleLabel: string;
  /** Group attribute `public_listing=true`: visitors may see the team roster. */
  publicListing: boolean;
  /** Group attribute `team_door_scan=true`: members may check attendees in at the team's events. */
  doorScan: boolean;
}>;

export type PrivilegeKind = "admin" | "board" | "audit";

export type PrivilegeLevel = Readonly<{
  kind: PrivilegeKind;
  label: string;
  description: string;
}>;

export type ApplicationPermission = Readonly<{
  code: string;
  label: string;
  description: string;
}>;

export type ApplicationAccess = Readonly<{
  clientId: string;
  name: string;
  description: string | null;
  /** Catalogued permissions in catalog order. */
  permissions: readonly ApplicationPermission[];
  /** Roles of this application the catalog does not know; their codes live in `technical.roles` only. */
  unlabelledCount: number;
}>;

export type TechnicalRole = Readonly<{ clientId: string; code: string }>;

export type PermissionsViewModel = Readonly<{
  /** `member` when any group sits in the `/UYELER` tree. */
  membership: "member" | "guest";
  teams: readonly TeamMembership[];
  privileges: readonly PrivilegeLevel[];
  applications: readonly ApplicationAccess[];
  technical: Readonly<{
    groupPaths: readonly string[];
    roles: readonly TechnicalRole[];
  }>;
}>;

const MEMBERS_ROOT = "UYELER";

const leaderSegments: Readonly<Record<string, Exclude<TeamRole, "member">>> = {
  LIDERLER: "leader",
  KOORDINATORLER: "coordinator",
};

const privilegedSegments: Readonly<Record<string, PrivilegeKind>> = {
  ADMIN: "admin",
  YK: "board",
  DK: "audit",
};

const teamRoleRank: Readonly<Record<TeamRole, number>> = { member: 0, coordinator: 1, leader: 2 };

const teamRoleLabels: Readonly<Record<TeamRole, string>> = {
  member: "Üye",
  leader: "Lider",
  coordinator: "Koordinatör",
};

const privilegeLevels: readonly PrivilegeLevel[] = [
  {
    kind: "admin",
    label: "Yönetim",
    description: "Kulüp kaynaklarını takım sınırı olmadan yönetebilirsin.",
  },
  {
    kind: "board",
    label: "Yönetim Kurulu",
    description: "Yönetim Kurulu üyesi olarak kulüp kaynaklarını takım sınırı olmadan yönetebilirsin.",
  },
  {
    kind: "audit",
    label: "Denetim Kurulu",
    description: "Denetim Kurulu üyesi olarak kulüp kaynaklarını takım sınırı olmadan yönetebilirsin.",
  },
];

const collator = new Intl.Collator("tr-TR", { sensitivity: "base" });

function pathSegments(path: string) {
  return path.split("/").filter((segment) => segment.length > 0);
}

function attributeValue(group: AccountGroup, name: string) {
  return group.attributes[name]?.find((value) => value.trim().length > 0)?.trim() ?? null;
}

function attributeTrue(group: AccountGroup, name: string) {
  return attributeValue(group, name)?.toLowerCase() === "true";
}

type TeamDraft = {
  path: string;
  segment: string;
  role: TeamRole;
  displayName: string | null;
  publicListing: boolean;
  doorScan: boolean;
};

function interpretGroups(groups: readonly AccountGroup[]) {
  const teams = new Map<string, TeamDraft>();
  const privileges = new Set<PrivilegeKind>();
  let membership: PermissionsViewModel["membership"] = "guest";

  for (const group of groups) {
    const segments = pathSegments(group.path);
    if (segments[0]?.toUpperCase() !== MEMBERS_ROOT) continue;
    membership = "member";
    const below = segments.slice(1);
    if (below.length === 0) continue;

    const privileged = below.map((segment) => privilegedSegments[segment.toUpperCase()]).find(Boolean);
    if (privileged) {
      privileges.add(privileged);
      continue;
    }

    const leaderIndex = below.findIndex((segment) => segment.toUpperCase() in leaderSegments);
    const teamSegments = leaderIndex === -1 ? below : below.slice(0, leaderIndex);
    if (teamSegments.length === 0) continue;
    const role: TeamRole = leaderIndex === -1
      ? "member"
      : leaderSegments[below[leaderIndex]!.toUpperCase()]!;
    const teamPath = `/${[segments[0]!, ...teamSegments].join("/")}`;

    const draft = teams.get(teamPath) ?? {
      path: teamPath,
      segment: teamSegments[teamSegments.length - 1]!,
      role: "member",
      displayName: null,
      publicListing: false,
      doorScan: false,
    };
    if (teamRoleRank[role] > teamRoleRank[draft.role]) draft.role = role;
    if (role === "member") draft.displayName = attributeValue(group, "display_name_tr") ?? draft.displayName;
    draft.publicListing = draft.publicListing || attributeTrue(group, "public_listing");
    draft.doorScan = draft.doorScan || attributeTrue(group, "team_door_scan");
    teams.set(teamPath, draft);
  }

  const memberships: TeamMembership[] = [...teams.values()].map((draft) => ({
    path: draft.path,
    name: draft.displayName ?? draft.segment,
    role: draft.role,
    roleLabel: teamRoleLabels[draft.role],
    publicListing: draft.publicListing,
    doorScan: draft.doorScan,
  }));
  memberships.sort((left, right) =>
    teamRoleRank[right.role] - teamRoleRank[left.role] ||
    collator.compare(left.name, right.name) ||
    left.path.localeCompare(right.path));

  return {
    membership,
    teams: memberships,
    privileges: privilegeLevels.filter(({ kind }) => privileges.has(kind)),
  };
}

type ResolvedApplication = {
  clientId: string;
  name: string;
  description: string | null;
  roles: Readonly<Record<string, PermissionLabel>>;
  order: number;
};

function resolveApplication(clientId: string, roles: readonly string[]): ResolvedApplication | null {
  const index = applicationCatalog.findIndex((application) => application.clientIds.includes(clientId));
  if (index !== -1) {
    const definition: ApplicationDefinition = applicationCatalog[index]!;
    return {
      clientId: definition.clientIds[0]!,
      name: definition.name,
      description: definition.description,
      roles: definition.roles,
      order: index,
    };
  }
  if (roles.some((role) => role in siteRoleCatalog)) {
    return {
      clientId,
      name: siteClientNames[clientId] ?? clientId,
      description: "İçerik yönetimi (CMS)",
      roles: siteRoleCatalog,
      order: applicationCatalog.length,
    };
  }
  return null;
}

function interpretAuthorization(authorization: SkyAuthorization) {
  const applications = new Map<string, { resolved: ResolvedApplication; held: Set<string>; unlabelled: number }>();
  const technical: TechnicalRole[] = [];

  for (const [rawClientId, roles] of Object.entries(authorization)) {
    if (keycloakInternalClientIds.has(rawClientId) || roles.length === 0) continue;
    for (const code of roles) technical.push({ clientId: rawClientId, code });
    const resolved = resolveApplication(rawClientId, roles);
    if (!resolved) continue;
    const entry = applications.get(resolved.clientId) ?? { resolved, held: new Set<string>(), unlabelled: 0 };
    for (const code of roles) {
      if (code in resolved.roles) entry.held.add(code);
      else entry.unlabelled += 1;
    }
    applications.set(resolved.clientId, entry);
  }

  const access: ApplicationAccess[] = [...applications.values()].map(({ resolved, held, unlabelled }) => ({
    clientId: resolved.clientId,
    name: resolved.name,
    description: resolved.description,
    permissions: Object.entries(resolved.roles)
      .filter(([code]) => held.has(code))
      .map(([code, { label, description }]) => ({ code, label, description })),
    unlabelledCount: unlabelled,
  }));
  access.sort((left, right) => {
    const orderDelta = (applications.get(left.clientId)!.resolved.order) - (applications.get(right.clientId)!.resolved.order);
    return orderDelta || left.clientId.localeCompare(right.clientId);
  });
  technical.sort((left, right) =>
    left.clientId.localeCompare(right.clientId) || left.code.localeCompare(right.code));

  return { applications: access, roles: technical };
}

export function buildPermissionsViewModel(input: {
  groups: readonly AccountGroup[];
  authorization: SkyAuthorization;
}): PermissionsViewModel {
  const { membership, teams, privileges } = interpretGroups(input.groups);
  const { applications, roles } = interpretAuthorization(input.authorization);
  return {
    membership,
    teams,
    privileges,
    applications,
    technical: {
      groupPaths: input.groups.map(({ path }) => path).sort(),
      roles,
    },
  };
}
