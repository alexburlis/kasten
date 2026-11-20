// "Show sender and subject in notifications": on by default, in the app's saved settings and in the
// copy the service worker reads. Also the service worker's copy of whether the push subscription
// asks for emailPush.
import { describe, expect, it } from "vitest";

import { DEFAULT_PREFS } from "../src/state/store.ts";
import { prefsRecord } from "../src/store/records.ts";
import { storedEmailPush, storedNoticeDetails } from "../src/sw/notice-prefs.ts";

describe("the app's saved settings", () => {
  it("turn sender and subject on for a device that saved settings before the option existed", () => {
    expect(prefsRecord.parse({ lockMinutes: 5 })).toEqual({
      lockMinutes: 5,
      notificationDetails: true,
    });
  });

  it("keep the choice", () => {
    expect(prefsRecord.parse({ lockMinutes: 15, notificationDetails: false })).toMatchObject({
      notificationDetails: false,
    });
  });

  it("are on by default", () => {
    expect(DEFAULT_PREFS.notificationDetails).toBe(true);
  });
});

describe("the service worker's copy", () => {
  it("is on when the app never saved it", () => {
    expect(storedNoticeDetails.parse(undefined)).toBe(true);
  });

  it.each([true, false])("reads a saved %s", (details) => {
    expect(storedNoticeDetails.parse({ details })).toBe(details);
  });

  it.each([
    ["null", null],
    ["a string", "true"],
    ["a record of another shape", { show: true }],
    ["a non-boolean value", { details: "yes" }],
  ])("is off for %s, so a damaged record never shows more", (_name, value) => {
    expect(storedNoticeDetails.parse(value)).toBe(false);
  });
});

describe("the service worker's copy of what the push subscription asks for", () => {
  it.each([true, false])("reads a saved emailPush %s", (emailPush) => {
    expect(storedEmailPush.parse({ emailPush })).toBe(emailPush);
  });

  it.each([
    ["nothing saved", undefined],
    ["null", null],
    ["a record of another shape", { details: true }],
    ["a non-boolean value", { emailPush: "yes" }],
  ])("is no for %s, so every push still shows as new mail", (_name, value) => {
    expect(storedEmailPush.parse(value)).toBe(false);
  });
});
