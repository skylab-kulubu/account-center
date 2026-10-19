import { describe, expect, it } from "vitest";
import {
  categoryGroupId,
  isPreferenceCategory,
  parseCommunicationPreferencesView,
  preferenceFocus,
  preferencesLoginHref,
  preferencesPath,
  showsTrackingSwitch,
} from "@/lib/communication-preferences";
import { normalizeReturnTo } from "@/server/auth/oidc-flow";
import { allowedReturnQuery } from "@/lib/return-query";

const groupId = "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d01";
const cell = { explicit: null, enabled: true, origin: "default", from: null, effective: true };

function view(overrides: Record<string, unknown> = {}) {
  return {
    master: cell,
    club: { duyuru: cell, haber: cell },
    teams: [{
      groupId,
      code: "WEBLAB",
      displayName: "Web Laboratuvarı",
      path: "/UYELER/YAZILIM/WEBLAB",
      member: true,
      hidden: false,
      kinds: { duyuru: cell, haber: { ...cell, origin: "inherited", from: groupId } },
      children: [],
    }],
    following: [],
    followable: [{ groupId: "robolab", code: "ROBOLAB", displayName: "Robotik", path: "/UYELER/ROBOLAB" }],
    ...overrides,
  };
}

describe("communication preference categories", () => {
  it.each([
    "all",
    "club:duyuru",
    "club:haber",
    `team:${groupId}:duyuru`,
    "team:a.b_c-d:haber",
  ])("accepts %s", (category) => expect(isPreferenceCategory(category)).toBe(true));

  it.each([
    "",
    "club",
    "club:news",
    "all:duyuru",
    "team::duyuru",
    "team:-leading:duyuru",
    `team:${"a".repeat(65)}:duyuru`,
    "team:a/b:duyuru",
    "team:a:duyuru:extra",
    "TEAM:a:duyuru",
  ])("refuses %j", (category) => expect(isPreferenceCategory(category)).toBe(false));

  it("names the team of a team category only", () => {
    expect(categoryGroupId(`team:${groupId}:haber`)).toBe(groupId);
    expect(categoryGroupId("club:haber")).toBeNull();
    expect(categoryGroupId("all")).toBeNull();
  });
});

describe("the mail link's focus", () => {
  it("keeps a well-formed category on the e-mail channel", () => {
    expect(preferenceFocus("email", `team:${groupId}:duyuru`)).toBe(`team:${groupId}:duyuru`);
    expect(preferenceFocus(undefined, "club:haber")).toBe("club:haber");
  });

  it("drops another channel, a repeated parameter and a malformed category", () => {
    expect(preferenceFocus("push", "club:haber")).toBeNull();
    expect(preferenceFocus("email", ["club:haber", "all"])).toBeNull();
    expect(preferenceFocus("email", "team:<script>:duyuru")).toBeNull();
    expect(preferenceFocus("email", undefined)).toBeNull();
  });

  it("survives the login round trip only in its allow-listed form", () => {
    const search = new URLSearchParams({ kanal: "email", kategori: `team:${groupId}:duyuru`, t: "unsubscribe-token" });
    expect(allowedReturnQuery("/communication-preferences", search))
      .toBe(`?kanal=email&kategori=team%3A${groupId}%3Aduyuru`);
    expect(allowedReturnQuery("/communication-preferences", new URLSearchParams({ kanal: "sms", kategori: "x" }))).toBe("");
    expect(allowedReturnQuery("/club-profile", search)).toBe("");
  });
});

describe("the screen's own links", () => {
  it("keep the mail's row, and only a well-formed one", () => {
    expect(preferencesPath(null)).toBe("/communication-preferences");
    expect(preferencesPath("team:<x>:duyuru")).toBe("/communication-preferences");
    expect(preferencesPath(`team:${groupId}:haber`))
      .toBe(`/communication-preferences?kanal=email&kategori=team%3A${groupId}%3Ahaber`);
  });

  it("come back from a login unchanged", () => {
    const path = preferencesPath("club:duyuru");
    expect(normalizeReturnTo(path)).toBe(path);
    expect(preferencesLoginHref("club:duyuru")).toBe(`/login?returnTo=${encodeURIComponent(path)}`);
  });
});

describe("the browser's view parser", () => {
  it("reads the BFF view", () => {
    const parsed = parseCommunicationPreferencesView(view());
    expect(parsed?.teams[0]?.kinds.haber).toEqual({ ...cell, origin: "inherited", from: groupId });
    expect(parsed?.followable).toHaveLength(1);
  });

  it.each([
    ["a missing master switch", { master: undefined }],
    ["an unknown origin", { master: { ...cell, origin: "parent" } }],
    ["a malformed from", { master: { ...cell, from: "../x" } }],
    ["a missing kind", { club: { duyuru: cell } }],
    ["a control character in a name", { followable: [{ groupId: "x", code: "X", displayName: "a\u0000b", path: "" }] }],
    ["a row without children", { following: [{ ...view().teams[0], children: undefined }] }],
    ["a malformed group id", { following: [{ ...view().teams[0], groupId: "a b" }] }],
  ])("fails closed on %s", (_, overrides) => {
    expect(parseCommunicationPreferencesView(view(overrides))).toBeNull();
  });

  it("reads the tracking switch, and a core without it as none", () => {
    expect(parseCommunicationPreferencesView(view({ tracking: { enabled: false, effective: false } }))?.tracking)
      .toEqual({ enabled: false, effective: false });
    expect(parseCommunicationPreferencesView(view())?.tracking).toBeNull();
    expect(parseCommunicationPreferencesView(view({ tracking: null }))?.tracking).toBeNull();
  });

  it.each([
    ["a tracking switch without effective", { tracking: { enabled: true } }],
    ["a tracking value that is not a choice", { tracking: { enabled: "no", effective: false } }],
    ["a tracking switch that is not an object", { tracking: true }],
  ])("fails closed on %s", (_, overrides) => {
    expect(parseCommunicationPreferencesView(view(overrides))).toBeNull();
  });

  it("refuses a tree deeper than any team tree", () => {
    let row: Record<string, unknown> = { ...view().teams[0], children: [] };
    for (let depth = 0; depth < 20; depth += 1) row = { ...view().teams[0], children: [row] };
    expect(parseCommunicationPreferencesView(view({ teams: [row] }))).toBeNull();
  });
});

describe("the tracking switch", () => {
  it("shows while the person is tracked or has turned it off", () => {
    expect(showsTrackingSwitch({ enabled: true, effective: true })).toBe(true);
    expect(showsTrackingSwitch({ enabled: false, effective: false })).toBe(true);
  });

  it("hides when core tracks nobody it could turn off (no Member) or does not serve it", () => {
    expect(showsTrackingSwitch({ enabled: true, effective: false })).toBe(false);
    expect(showsTrackingSwitch(null)).toBe(false);
  });
});
