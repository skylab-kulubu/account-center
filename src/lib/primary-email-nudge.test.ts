import { describe, expect, it } from "vitest";
import {
  isPrimaryEmailNudge,
  PRIMARY_EMAIL_NUDGES,
  primaryEmailNudgeFor,
  primaryEmailNudgeIntentPath,
} from "@/lib/primary-email-nudge";

const school = { primary: "school" as const, personalEmail: null, personalEmailVerified: false };
const none = new Set<never>();

describe("primaryEmailNudgeFor", () => {
  it("asks a school-primary person with a proven Personal e-mail to make it the Primary e-mail", () => {
    expect(primaryEmailNudgeFor({ ...school, personalEmail: "ada@example.com", personalEmailVerified: true }, none))
      .toBe("make-personal-primary");
  });

  it("asks a school-primary person without a Personal e-mail to add one", () => {
    expect(primaryEmailNudgeFor(school, none)).toBe("add-personal");
  });

  it("says nothing while the Personal e-mail is unproven: it cannot become primary and the page already explains why", () => {
    expect(primaryEmailNudgeFor({ ...school, personalEmail: "ada@example.com", personalEmailVerified: false }, none)).toBeNull();
  });

  it.each(["personal", "none"] as const)("says nothing when the Primary e-mail is %s", (primary) => {
    expect(primaryEmailNudgeFor({ primary, personalEmail: "ada@example.com", personalEmailVerified: true }, none)).toBeNull();
    expect(primaryEmailNudgeFor({ primary, personalEmail: null, personalEmailVerified: false }, none)).toBeNull();
  });

  it("stays quiet once the person dismissed that nudge, and only that one", () => {
    expect(primaryEmailNudgeFor(school, new Set(["add-personal"]))).toBeNull();
    expect(primaryEmailNudgeFor(
      { ...school, personalEmail: "ada@example.com", personalEmailVerified: true },
      new Set(["add-personal"]),
    )).toBe("make-personal-primary");
    expect(primaryEmailNudgeFor(
      { ...school, personalEmail: "ada@example.com", personalEmailVerified: true },
      new Set(["make-personal-primary"]),
    )).toBeNull();
  });
});

describe("nudge keys", () => {
  it("accepts only the two known nudges", () => {
    expect(PRIMARY_EMAIL_NUDGES).toEqual(["make-personal-primary", "add-personal"]);
    for (const nudge of PRIMARY_EMAIL_NUDGES) expect(isPrimaryEmailNudge(nudge)).toBe(true);
    for (const value of ["", "Add-Personal", "remove-personal", null, 1, {}]) expect(isPrimaryEmailNudge(value)).toBe(false);
  });

  it("links each nudge to the e-mail page flow it opens", () => {
    expect(primaryEmailNudgeIntentPath("make-personal-primary")).toBe("/email?intent=make-personal-primary");
    expect(primaryEmailNudgeIntentPath("add-personal")).toBe("/email?intent=add-personal");
  });
});
