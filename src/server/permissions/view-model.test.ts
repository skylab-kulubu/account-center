// @vitest-environment node

import { describe, expect, it } from "vitest";
import groupsFixture from "../../../tests/fixtures/keycloak-26.7.4-account-groups.json";
import { parseGroups } from "@/server/keycloak-account/schema";
import type { AccountGroup } from "@/server/keycloak-account/types";
import { buildPermissionsViewModel } from "@/server/permissions/view-model";

function group(path: string, attributes: Record<string, string[]> = {}): AccountGroup {
  const name = path.split("/").filter(Boolean).at(-1) ?? path;
  return { id: `id:${path}`, name, path, attributes };
}

describe("Permissions view model", () => {
  describe("teams from Keycloak groups", () => {
    it("lists a direct team membership with its Turkish display name", () => {
      const model = buildPermissionsViewModel({
        groups: [
          group("/UYELER"),
          group("/UYELER/ARGE/WEBLAB", { display_name_tr: ["WebLab"], team_slug: ["weblab"] }),
        ],
        authorization: {},
      });
      expect(model.membership).toBe("member");
      expect(model.teams).toEqual([{
        path: "/UYELER/ARGE/WEBLAB",
        name: "WebLab",
        role: "member",
        roleLabel: "Üye",
        publicListing: false,
        doorScan: false,
      }]);
      expect(model.privileges).toEqual([]);
    });

    it("falls back to the last path segment when the group has no Turkish name", () => {
      const model = buildPermissionsViewModel({
        groups: [group("/UYELER/SKYSEC", { display_name_tr: ["   "] })],
        authorization: {},
      });
      expect(model.teams.map(({ name }) => name)).toEqual(["SKYSEC"]);
    });

    it("marks the person as leader or coordinator through the nested source group", () => {
      const model = buildPermissionsViewModel({
        groups: [
          group("/UYELER/ARGE/WEBLAB", { display_name_tr: ["WebLab"] }),
          group("/UYELER/ARGE/WEBLAB/LIDERLER"),
          group("/UYELER/GECEKODU/KOORDINATORLER"),
        ],
        authorization: {},
      });
      expect(model.teams).toEqual([
        expect.objectContaining({ path: "/UYELER/ARGE/WEBLAB", name: "WebLab", role: "leader", roleLabel: "Lider" }),
        expect.objectContaining({ path: "/UYELER/GECEKODU", name: "GECEKODU", role: "coordinator", roleLabel: "Koordinatör" }),
      ]);
    });

    it("keeps one card per team when the person sits in the team and its leader subgroup", () => {
      const model = buildPermissionsViewModel({
        groups: [
          group("/UYELER/ARGE/WEBLAB/LIDERLER"),
          group("/UYELER/ARGE/WEBLAB", { display_name_tr: ["WebLab"], team_door_scan: ["true"] }),
          group("/UYELER/ARGE/WEBLAB/KOORDINATORLER"),
        ],
        authorization: {},
      });
      expect(model.teams).toHaveLength(1);
      expect(model.teams[0]).toMatchObject({ name: "WebLab", role: "leader", doorScan: true });
    });

    it("reads the public listing and team door scan attributes case-insensitively", () => {
      const model = buildPermissionsViewModel({
        groups: [
          group("/UYELER/ARGE/ARTLAB", { public_listing: ["TRUE"], team_door_scan: ["false"] }),
          group("/UYELER/GECEKODU", { public_listing: ["yes"], team_door_scan: ["True"] }),
        ],
        authorization: {},
      });
      expect(model.teams.map(({ path, publicListing, doorScan }) => ({ path, publicListing, doorScan }))).toEqual([
        { path: "/UYELER/ARGE/ARTLAB", publicListing: true, doorScan: false },
        { path: "/UYELER/GECEKODU", publicListing: false, doorScan: true },
      ]);
    });

    it("orders leaders first and then by Turkish name", () => {
      const model = buildPermissionsViewModel({
        groups: [
          group("/UYELER/ARGE/WEBLAB", { display_name_tr: ["WebLab"] }),
          group("/UYELER/ARGE/ARTLAB", { display_name_tr: ["ArtLab"] }),
          group("/UYELER/ARGE/ARTLAB/LIDERLER"),
          group("/UYELER/ARGE/CHAINLAB", { display_name_tr: ["ChainLab"] }),
          group("/UYELER/ARGE/AIRLAB", { display_name_tr: ["AirLab"] }),
        ],
        authorization: {},
      });
      expect(model.teams.map(({ name }) => name)).toEqual(["ArtLab", "AirLab", "ChainLab", "WebLab"]);
    });

    it("does not turn the members root or groups outside it into teams", () => {
      const model = buildPermissionsViewModel({
        groups: [group("/UYELER"), group("/ARGE/WEBLAB", { display_name_tr: ["WebLab"] }), group("/EXTERNAL/PARTNER")],
        authorization: {},
      });
      expect(model.membership).toBe("member");
      expect(model.teams).toEqual([]);
      expect(model.technical.groupPaths).toEqual(["/ARGE/WEBLAB", "/EXTERNAL/PARTNER", "/UYELER"]);
    });
  });

  describe("privilege level", () => {
    it("maps ADMIN, YK and DK membership to the club wording", () => {
      const model = buildPermissionsViewModel({
        groups: [group("/UYELER/DK"), group("/UYELER/YK/BASKAN"), group("/UYELER/ADMIN")],
        authorization: {},
      });
      expect(model.privileges).toEqual([
        { kind: "admin", label: "Yönetim", description: expect.stringContaining("takım sınırı olmadan") },
        { kind: "board", label: "Yönetim Kurulu", description: expect.stringContaining("Yönetim Kurulu") },
        { kind: "audit", label: "Denetim Kurulu", description: expect.stringContaining("Denetim Kurulu") },
      ]);
      expect(model.teams).toEqual([]);
    });

    it("keeps a privileged person's ordinary teams as teams", () => {
      const model = buildPermissionsViewModel({
        groups: [group("/UYELER/YK"), group("/UYELER/ARGE/WEBLAB", { display_name_tr: ["WebLab"] })],
        authorization: {},
      });
      expect(model.privileges.map(({ kind }) => kind)).toEqual(["board"]);
      expect(model.teams.map(({ name }) => name)).toEqual(["WebLab"]);
    });

    it("reports a person without any group as a plain user", () => {
      const model = buildPermissionsViewModel({ groups: [], authorization: {} });
      expect(model).toEqual({
        membership: "guest",
        teams: [],
        privileges: [],
        applications: [],
        technical: { groupPaths: [], roles: [] },
      });
    });
  });

  describe("application permissions from sky_authorization", () => {
    it("labels catalogued roles per application in catalog order", () => {
      const model = buildPermissionsViewModel({
        groups: [],
        authorization: {
          skymail: ["skymail:lists:write", "skymail:access"],
          core: ["url:create", "certificate:issue"],
        },
      });
      expect(model.applications.map(({ clientId, name }) => ({ clientId, name }))).toEqual([
        { clientId: "core", name: "SKY LAB Core" },
        { clientId: "skymail", name: "SkyMail" },
      ]);
      expect(model.applications[0]?.permissions).toEqual([
        { code: "url:create", label: "Kısa bağlantı oluşturma", description: expect.stringContaining("kısa bağlantı") },
        { code: "certificate:issue", label: "Sertifika verme", description: expect.stringContaining("sertifika") },
      ]);
      expect(model.applications[1]?.permissions.map(({ label }) => label)).toEqual([
        "SkyMail’e giriş",
        "Alıcı listesi yönetimi",
      ]);
      expect(model.technical.roles).toEqual([
        { clientId: "core", code: "certificate:issue" },
        { clientId: "core", code: "url:create" },
        { clientId: "skymail", code: "skymail:access" },
        { clientId: "skymail", code: "skymail:lists:write" },
      ]);
    });

    it("folds legacy Skyforms client ids into one application", () => {
      const model = buildPermissionsViewModel({
        groups: [],
        authorization: { forms: ["skyforms:access"], skyforms: ["skyforms:form:manage"], dotnet: ["skyforms:*"] },
      });
      expect(model.applications).toHaveLength(1);
      expect(model.applications[0]).toMatchObject({ clientId: "forms", name: "Skyforms", unlabelledCount: 0 });
      expect(model.applications[0]?.permissions.map(({ code }) => code)).toEqual([
        "skyforms:access",
        "skyforms:form:manage",
        "skyforms:*",
      ]);
    });

    it("names CMS access after the site client it belongs to", () => {
      const model = buildPermissionsViewModel({
        groups: [],
        authorization: { "skylab-site": ["cms:access"], arge: ["cms:access"], "unknown-site": ["cms:access"] },
      });
      expect(model.applications.map(({ clientId, name, permissions }) => ({
        clientId,
        name,
        labels: permissions.map(({ label }) => label),
      }))).toEqual([
        { clientId: "arge", name: "AR-GE sitesi", labels: ["İçerik düzenleme"] },
        { clientId: "skylab-site", name: "yildizskylab.com", labels: ["İçerik düzenleme"] },
        { clientId: "unknown-site", name: "unknown-site", labels: ["İçerik düzenleme"] },
      ]);
    });

    it("counts unknown roles of a known application without labelling them", () => {
      const model = buildPermissionsViewModel({
        groups: [],
        authorization: { core: ["events:write", "url:create"], superadmin: ["superadmin:beta"] },
      });
      expect(model.applications).toEqual([
        expect.objectContaining({ clientId: "core", unlabelledCount: 1, permissions: [expect.objectContaining({ code: "url:create" })] }),
        expect.objectContaining({ clientId: "superadmin", name: "Superadmin", unlabelledCount: 1, permissions: [] }),
      ]);
      expect(JSON.stringify(model.applications)).not.toContain("events:write");
      expect(model.technical.roles).toContainEqual({ clientId: "core", code: "events:write" });
      expect(model.technical.roles).toContainEqual({ clientId: "superadmin", code: "superadmin:beta" });
    });

    it("keeps roles of unknown applications in the technical section only", () => {
      const model = buildPermissionsViewModel({
        groups: [],
        authorization: { skylapp: ["skylapp:access"], "sky-app": [] },
      });
      expect(model.applications).toEqual([]);
      expect(model.technical.roles).toEqual([{ clientId: "skylapp", code: "skylapp:access" }]);
    });

    it("drops Keycloak's own client roles entirely", () => {
      const model = buildPermissionsViewModel({
        groups: [],
        authorization: {
          account: ["manage-account", "view-profile", "manage-account-links"],
          "realm-management": ["view-users"],
          broker: ["read-token"],
        },
      });
      expect(model.applications).toEqual([]);
      expect(model.technical.roles).toEqual([]);
    });
  });

  it("never carries realm roles or group role mappings from the pinned fixture", () => {
    const groups = parseGroups(groupsFixture);
    const model = buildPermissionsViewModel({ groups, authorization: { core: ["url:create"] } });
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain("member-of-weblab");
    expect(serialized).not.toContain("private-realm-role");
    expect(serialized).not.toContain("private-client-role");
    expect(serialized).not.toContain("team.weblab");
    expect(model.technical.groupPaths).toEqual(["/ARGE/WEBLAB", "/ARGE/WEBLAB/LIDERLER", "/UYELER"]);
  });
});
