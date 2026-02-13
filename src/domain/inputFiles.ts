export type InputKind = "이미지" | "PDF";

export type InputFile = {
  path: string;
  name: string;
  ext: string;
  kind: InputKind;
};

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp"]);
const PDF_EXT = "pdf";

export function inferInputFile(path: string): InputFile | null {
  const trimmed = path.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/\\/g, "/");
  const name = normalized.split("/").pop() ?? normalized;

  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";

  if (IMAGE_EXTS.has(ext)) {
    return { path: trimmed, name, ext, kind: "이미지" };
  }

  if (ext === PDF_EXT) {
    return { path: trimmed, name, ext, kind: "PDF" };
  }

  return null;
}

export function addPathsUnique(
  prev: InputFile[],
  paths: string[],
): {
  next: InputFile[];
  rejected: string[];
} {
  const seen = new Set(prev.map((f) => f.path));
  const next = [...prev];
  const rejected: string[] = [];

  for (const p of paths) {
    const file = inferInputFile(p);
    if (!file) {
      rejected.push(p);
      continue;
    }
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    next.push(file);
  }

  return { next, rejected };
}
