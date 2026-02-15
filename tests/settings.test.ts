// @ts-nocheck
import { expect, test } from "bun:test";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/domain/settings";

test("sanitizeSettings defaults invalid position and sizePercent", () => {
  const sanitized = sanitizeSettings({
    position: "center",
    sizePercent: "giant",
    updateCheckOnLaunch: "yes",
    updateCheckIntervalMins: "often",
    marginPercent: "not-a-number",
  });

  expect(sanitized).toEqual({
    position: DEFAULT_SETTINGS.position,
    sizePercent: DEFAULT_SETTINGS.sizePercent,
    updateCheckOnLaunch: DEFAULT_SETTINGS.updateCheckOnLaunch,
    updateCheckIntervalMins: DEFAULT_SETTINGS.updateCheckIntervalMins,
  });
  expect("marginPercent" in sanitized).toBe(false);
});

test("sanitizeSettings clamps sizePercent to safe range", () => {
  expect(sanitizeSettings({ sizePercent: -10 }).sizePercent).toBe(1);
  expect(sanitizeSettings({ sizePercent: 999 }).sizePercent).toBe(300);
  expect(sanitizeSettings({ sizePercent: 12.6 }).sizePercent).toBe(13);
});

test("sanitizeSettings converts legacy sizePreset to sizePercent", () => {
  expect(sanitizeSettings({ sizePreset: "작음" }).sizePercent).toBe(8);
  expect(sanitizeSettings({ sizePreset: "보통" }).sizePercent).toBe(12);
  expect(sanitizeSettings({ sizePreset: "큼" }).sizePercent).toBe(16);
});

test("sanitizeSettings uses 30 default sizePercent without legacy preset", () => {
  expect(sanitizeSettings({}).sizePercent).toBe(30);
  expect(sanitizeSettings({ sizePercent: Number.NaN }).sizePercent).toBe(30);
});

test("sanitizeSettings defaults and validates update-check settings", () => {
  const defaults = sanitizeSettings({});
  expect(defaults.updateCheckOnLaunch).toBe(true);
  expect(defaults.updateCheckIntervalMins).toBe(60);

  expect(sanitizeSettings({ updateCheckOnLaunch: false }).updateCheckOnLaunch).toBe(false);
  expect(sanitizeSettings({ updateCheckIntervalMins: -1 }).updateCheckIntervalMins).toBe(0);
  expect(sanitizeSettings({ updateCheckIntervalMins: 5.6 }).updateCheckIntervalMins).toBe(6);
  expect(sanitizeSettings({ updateCheckIntervalMins: 5000 }).updateCheckIntervalMins).toBe(1440);
});
