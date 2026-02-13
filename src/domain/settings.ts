export type Position = "좌상단" | "우상단" | "좌하단" | "우하단";

export type CornerBrandSettings = {
  position: Position;
  sizePercent: number;
};

export const DEFAULT_SETTINGS: CornerBrandSettings = {
  position: "우하단",
  sizePercent: 30,
};

const STORAGE_KEY = "cornerbrand.settings.v1";

function isPosition(value: unknown): value is Position {
  return value === "좌상단" || value === "우상단" || value === "좌하단" || value === "우하단";
}

function clampSizePercent(value: number): number {
  return Math.min(50, Math.max(1, value));
}

function getLegacySizePercent(value: unknown): number | null {
  if (value === "작음") return 8;
  if (value === "보통") return 12;
  if (value === "큼") return 16;
  return null;
}

export function sanitizeSettings(input: unknown): CornerBrandSettings {
  const obj = (input ?? {}) as Record<string, unknown>;
  const sizePercentFromInput =
    typeof obj.sizePercent === "number" && Number.isFinite(obj.sizePercent)
      ? clampSizePercent(Math.round(obj.sizePercent))
      : null;
  const legacySizePercent = getLegacySizePercent(obj.sizePreset);

  return {
    position: isPosition(obj.position) ? obj.position : DEFAULT_SETTINGS.position,
    sizePercent: sizePercentFromInput ?? legacySizePercent ?? DEFAULT_SETTINGS.sizePercent,
  };
}

export function loadSettings(): CornerBrandSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return sanitizeSettings(parsed);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: CornerBrandSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage failures
  }
}
