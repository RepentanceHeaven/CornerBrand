// @ts-nocheck
import { expect, test } from "bun:test";
import { addPathsUnique, inferInputFile, type InputFile } from "../src/domain/inputFiles";

test("inferInputFile recognizes supported extensions", () => {
  expect(inferInputFile("C:/sample/photo.jpg")).toEqual({
    path: "C:/sample/photo.jpg",
    name: "photo.jpg",
    ext: "jpg",
    kind: "이미지",
  });

  expect(inferInputFile("C:/sample/photo.PNG")?.kind).toBe("이미지");
  expect(inferInputFile("C:/sample/logo.webp")?.kind).toBe("이미지");
  expect(inferInputFile("C:/sample/doc.pdf")?.kind).toBe("PDF");
});

test("inferInputFile rejects unsupported and blank paths", () => {
  expect(inferInputFile("   ")).toBeNull();
  expect(inferInputFile("C:/sample/movie.mp4")).toBeNull();
  expect(inferInputFile("C:/sample/no-extension")).toBeNull();
});

test("addPathsUnique dedupes by exact path and reports rejected", () => {
  const prev: InputFile[] = [
    {
      path: "C:/input/a.jpg",
      name: "a.jpg",
      ext: "jpg",
      kind: "이미지",
    },
  ];

  const { next, rejected } = addPathsUnique(prev, [
    "C:/input/a.jpg",
    "C:/input/A.jpg",
    "C:/input/b.png",
    "C:/input/unsupported.txt",
    "",
  ]);

  expect(next.map((f) => f.path)).toEqual([
    "C:/input/a.jpg",
    "C:/input/A.jpg",
    "C:/input/b.png",
  ]);
  expect(rejected).toEqual(["C:/input/unsupported.txt", ""]);
});
