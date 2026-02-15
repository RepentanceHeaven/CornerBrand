import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./styles/app.css";
import { strings } from "./ui/strings";
import { confirm, message, open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { check } from "@tauri-apps/plugin-updater";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { addPathsUnique, type InputFile } from "./domain/inputFiles";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type CornerBrandSettings,
} from "./domain/settings";

type StampFileResult = {
  inputPath: string;
  ok: boolean;
  outputPath: string | null;
  error: string | null;
};

type BatchProgressEvent = {
  requestId: string;
  total: number;
  done: number;
  inputPath: string;
  ok: boolean;
};

type UpdateDownloadState = {
  active: boolean;
  percent: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
};

type NoticeState = {
  kind: "info" | "error";
  message: string;
};

const UPDATE_TOAST_ROLE = "status";
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "bmp", "gif", "svg"]);
const PREVIEW_MAX_SIDE_PX = 1600;

function getPathExtension(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const ext = normalized.split(".").pop();
  return ext ? ext.toLowerCase() : "";
}

function isImagePath(path: string) {
  return IMAGE_EXTENSIONS.has(getPathExtension(path));
}

function normalizePathForMatch(path: string) {
  return path.replace(/\\/g, "/").toLowerCase();
}

function isCornerBrandOutputPath(path: string) {
  const normalized = normalizePathForMatch(path);
  const segments = normalized.split("/").filter(Boolean);
  const baseName = segments[segments.length - 1] ?? "";

  return (
    segments.includes("cornerbrand_output") ||
    segments.includes("cornerbrand-preview") ||
    baseName.includes("_cornerbrand.") ||
    baseName.includes("_cornerbrand(")
  );
}

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

function clampPercent(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.min(300, Math.max(1, Math.round(value))) : fallback;
}

function resolveCornerPosition(
  position: CornerBrandSettings["position"],
  imageWidth: number,
  imageHeight: number,
  logoWidth: number,
  logoHeight: number,
) {
  const maxX = Math.max(0, imageWidth - logoWidth);
  const maxY = Math.max(0, imageHeight - logoHeight);

  switch (position) {
    case "좌상단":
      return { x: 0, y: 0 };
    case "우상단":
      return { x: maxX, y: 0 };
    case "좌하단":
      return { x: 0, y: maxY };
    case "우하단":
    default:
      return { x: maxX, y: maxY };
  }
}

async function loadImageElement(src: string) {
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  await image.decode();
  return image;
}

function toErrorDetail(error: unknown) {
  let detail = "";

  if (error instanceof Error) {
    detail = error.message;
  } else if (typeof error === "string") {
    detail = error;
  } else {
    try {
      detail = JSON.stringify(error) ?? "";
    } catch {
      detail = "";
    }
  }

  return detail.length > 500 ? detail.slice(0, 500) : detail;
}

function App() {
  const [logoOk, setLogoOk] = useState(true);
  const [headerIconSrc, setHeaderIconSrc] = useState("/icon.png");
  const [settings, setSettings] = useState<CornerBrandSettings>(() => loadSettings());
  const [customOutputDir, setCustomOutputDir] = useState<string | null>(null);

  const [files, setFiles] = useState<InputFile[]>([]);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressTotal, setProgressTotal] = useState(0);
  const [progressDone, setProgressDone] = useState(0);
  const [progressFileName, setProgressFileName] = useState<string | null>(null);
  const [results, setResults] = useState<StampFileResult[]>([]);
  const [selectedResultInputPath, setSelectedResultInputPath] = useState<string | null>(null);
  const [fileSizePercentByPath, setFileSizePercentByPath] = useState<Record<string, number>>({});
  const activeRequestIdRef = useRef<string | null>(null);
  const updateCheckStartedRef = useRef(false);
  const [isUpdateChecking, setIsUpdateChecking] = useState(false);
  const [appVersion, setAppVersion] = useState("-");
  const [updateDownload, setUpdateDownload] = useState<UpdateDownloadState>({
    active: false,
    percent: null,
    downloadedBytes: null,
    totalBytes: null,
  });
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState<string>("");
  const [selectedPreviewImageFailedPath, setSelectedPreviewImageFailedPath] = useState<string | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCompositeRequestIdRef = useRef(0);

  const runUpdateCheck = useCallback(async ({ showNoUpdateNotice }: { showNoUpdateNotice: boolean }) => {
    if (!isTauriRuntime() || isUpdateChecking) return;

    let update: Awaited<ReturnType<typeof check>> | null = null;
    setIsUpdateChecking(true);

    try {
      update = await check();
      if (!update) {
        if (showNoUpdateNotice) {
          setNotice({ kind: "info", message: strings.updateNoUpdate });
        }
        return;
      }

      const plainNotes = (update.body ?? "").replace(/\s+/g, " ").trim();
      const notes =
        plainNotes.length > 280 ? `${plainNotes.slice(0, 280)}...` : plainNotes || strings.updateNoNotes;
      const shouldInstall = await confirm(
        strings.updateConfirm
          .replace("{version}", update.version)
          .replace("{notes}", notes),
      );

      if (!shouldInstall) return;

      let downloadedBytes = 0;
      let totalBytes: number | null = null;
      setUpdateDownload({ active: true, percent: null, downloadedBytes: 0, totalBytes: null });

      await update.downloadAndInstall((progress) => {
        if (progress.event === "Started") {
          const rawTotal = Number(progress.data.contentLength);
          totalBytes = Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : null;
          downloadedBytes = 0;
          setUpdateDownload({ active: true, percent: 0, downloadedBytes: 0, totalBytes });
          return;
        }

        if (progress.event === "Progress") {
          const chunkLength = Number(progress.data.chunkLength);
          if (Number.isFinite(chunkLength) && chunkLength > 0) {
            downloadedBytes += chunkLength;
          }

          const percent = totalBytes
            ? Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)))
            : null;

          setUpdateDownload({
            active: true,
            percent,
            downloadedBytes,
            totalBytes,
          });
          return;
        }

        if (progress.event === "Finished") {
          setUpdateDownload((prev) => ({
            active: true,
            percent: prev.totalBytes ? 100 : prev.percent,
            downloadedBytes: prev.downloadedBytes,
            totalBytes: prev.totalBytes,
          }));
        }
      });

      setUpdateDownload((prev) => ({
        ...prev,
        active: false,
        percent: prev.percent ?? 100,
      }));
      await message(strings.updateInstalled);
    } catch (error) {
      const detail = toErrorDetail(error);
      setNotice({
        kind: "error",
        message: detail ? `${strings.updateCheckFailed}: ${detail}` : strings.updateCheckFailed,
      });
    } finally {
      setIsUpdateChecking(false);
      if (update) {
        try {
          await update.close();
        } catch {
          // ignore close errors
        }
      }
    }
  }, [isUpdateChecking]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // (preview debounce removed) intentionally no cleanup needed

  useEffect(() => {
    if (!isTauriRuntime()) {
      setAppVersion("-");
      return;
    }

    (async () => {
      try {
        const version = await getVersion();
        setAppVersion(version || "-");
      } catch {
        setAppVersion("-");
      }
    })();
  }, []);

  useEffect(() => {
    if (updateCheckStartedRef.current) return;
    updateCheckStartedRef.current = true;
    void runUpdateCheck({ showNoUpdateNotice: false });
  }, [runUpdateCheck]);

  const { position, sizePercent } = settings;

  const addInputPaths = useCallback(
    (paths: string[]) => {
      let addedPaths: string[] = [];
      let excludedOutputCount = 0;
      let rejectedCount = 0;
      const filteredPaths: string[] = [];

      for (const path of paths) {
        if (isCornerBrandOutputPath(path)) {
          excludedOutputCount += 1;
          continue;
        }

        filteredPaths.push(path);
      }

      setFiles((prev) => {
        const prevPaths = new Set(prev.map((file) => file.path));
        const { next, rejected } = addPathsUnique(prev, filteredPaths);
        rejectedCount = rejected.length;
        addedPaths = next.filter((file) => !prevPaths.has(file.path)).map((file) => file.path);
        return next;
      });

      if (excludedOutputCount > 0 || rejectedCount > 0) {
        const notices: string[] = [];
        if (excludedOutputCount > 0) {
          notices.push(strings.excludedOutputFiles.replace("{count}", String(excludedOutputCount)));
        }
        if (rejectedCount > 0) {
          notices.push(strings.unsupportedFiles);
        }

        setNotice({ kind: "info", message: notices.join(" ") });
      }

      if (addedPaths.length > 0) {
        setSelectedResultInputPath((prev) => prev ?? addedPaths[0] ?? null);
      }

      // No automatic backend run on add.
    },
    [],
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        unlisten = await getCurrentWindow().listen<{ paths: string[] }>(
          "tauri://drag-drop",
          (event) => {
            addInputPaths(event.payload.paths);
          },
        );
      } catch {
        // Drag-drop listener is optional; file picker remains available.
      }
    })();

    return () => {
      try {
        unlisten?.();
      } catch {
        // ignore
      }
    };
  }, [addInputPaths]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        unlisten = await getCurrentWindow().listen<BatchProgressEvent>(
          "cornerbrand://progress",
          (event) => {
            const payload = event.payload;
            if (!payload || payload.requestId !== activeRequestIdRef.current) return;

            const total = Number.isFinite(payload.total) ? Math.max(0, payload.total) : 0;
            const done = Number.isFinite(payload.done)
              ? Math.max(0, Math.min(payload.done, total || payload.done))
              : 0;
            const fileName = payload.inputPath.replace(/\\/g, "/").split("/").pop() ?? null;

            setProgressTotal(total);
            setProgressDone(done);
            setProgressFileName(fileName);
          },
        );
      } catch {
        // Progress listener is optional; execution still works without live updates.
      }
    })();

    return () => {
      try {
        unlisten?.();
      } catch {
        // ignore
      }
    };
  }, []);

  async function pickFiles() {
    setNotice(null);
    try {
      const result = await open({
        multiple: true,
        directory: false,
        filters: [
          { name: "이미지", extensions: ["jpg", "jpeg", "png", "webp"] },
          { name: "PDF", extensions: ["pdf"] },
        ],
      });
      if (!result) return;

      const paths = Array.isArray(result) ? result : [result];
      addInputPaths(paths);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      setNotice({
        kind: "error",
        message: detail ? `${strings.pickerFailed} ${detail}` : strings.pickerFailed,
      });
    }
  }

  async function pickOutputDir() {
    setNotice(null);
    try {
      const result = await open({
        multiple: false,
        directory: true,
      });

      if (!result || Array.isArray(result)) return;
      setCustomOutputDir(result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      setNotice({
        kind: "error",
        message: detail ? `${strings.pickerFailed} ${detail}` : strings.pickerFailed,
      });
    }
  }

  const requestCancelBatch = useCallback(async () => {
    const requestId = activeRequestIdRef.current;
    if (!isProcessing || !requestId) return;

    try {
      await invoke<boolean>("cancel_stamp_batch", { requestId });
      setNotice({ kind: "info", message: "취소 요청됨" });
    } catch (error) {
      const detail = typeof error === "string" ? error : toErrorDetail(error);
      setNotice({
        kind: "error",
        message: detail ? `${strings.runFailed} ${detail}` : strings.runFailed,
      });
    }
  }, [isProcessing]);

  const runStampBatch = useCallback(async (pathsOverride?: string[]) => {
    const targetPaths =
      pathsOverride && pathsOverride.length > 0 ? pathsOverride : files.map((file) => file.path);

    if (targetPaths.length === 0 || isProcessing) return;
    setNotice(null);
    setIsProcessing(true);
    setProgressTotal(targetPaths.length);
    setProgressDone(0);
    setProgressFileName(null);

    const requestId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    activeRequestIdRef.current = requestId;
    const targetSizePercentByPath = Object.fromEntries(
      targetPaths.map((path) => [path, fileSizePercentByPath[path] ?? sizePercent]),
    );
    const command = "stamp_batch_progress";

    try {
      const stampResults = await invoke<StampFileResult[]>(command, {
        paths: targetPaths,
        settings: {
          position,
          sizePercent,
          marginPercent: 0,
        },
        sizePercentByPath: targetSizePercentByPath,
        outputDir: customOutputDir,
        requestId,
      });
      let nextSelected: string | null = null;
      setResults((prev) => {
        const byPath = new Map(prev.map((result) => [result.inputPath, result]));
        for (const result of stampResults) {
          byPath.set(result.inputPath, result);
        }

        const ordered = files
          .map((file) => byPath.get(file.path))
          .filter((value): value is StampFileResult => Boolean(value));

        const extras = Array.from(byPath.values()).filter(
          (result) => !files.some((file) => file.path === result.inputPath),
        );
        const merged = [...ordered, ...extras];
        if (
          selectedResultInputPath &&
          merged.some((result) => result.inputPath === selectedResultInputPath)
        ) {
          nextSelected = selectedResultInputPath;
        } else {
          nextSelected =
            merged.find((result) => result.ok)?.inputPath ??
            merged[0]?.inputPath ??
            null;
        }
        return merged;
      });
      setSelectedResultInputPath(nextSelected);
    } catch (error) {
      const detail = typeof error === "string" ? error : strings.runFailed;
      setNotice({ kind: "error", message: `${strings.runFailed} ${detail}` });
      setResults([]);
      setSelectedResultInputPath(null);
    } finally {
      activeRequestIdRef.current = null;
      setProgressTotal(0);
      setProgressDone(0);
      setProgressFileName(null);
      setIsProcessing(false);
    }
  }, [
    customOutputDir,
    fileSizePercentByPath,
    files,
    isProcessing,
    position,
    selectedResultInputPath,
    sizePercent,
  ]);

  // No automatic preview generation.

  async function openExternalPath(path: string) {
    try {
      await openPath(path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      setNotice({
        kind: "error",
        message: detail ? `${strings.pickerFailed} ${detail}` : strings.pickerFailed,
      });
    }
  }

  async function openPreviewOrPath(path: string, name: string) {
    if (isImagePath(path)) {
      setPreviewPath(path);
      setPreviewName(name);
      return;
    }

    await openExternalPath(path);
  }

  const runHint = useMemo(() => {
    if (files.length === 0) return "파일을 먼저 추가하세요";
    return isProcessing ? strings.processing : strings.save;
  }, [files.length, isProcessing]);

  const resultSummary = useMemo(() => {
    const total = results.length;
    const success = results.filter((result) => result.ok).length;
    const failure = total - success;
    return { total, success, failure };
  }, [results]);

  const logoPreviewSrc = "/logo.webp";

  const previewImageSrc = useMemo(
    () => (previewPath ? convertFileSrc(previewPath) : null),
    [previewPath],
  );

  const resultByInputPath = useMemo(
    () => new Map(results.map((result) => [result.inputPath, result])),
    [results],
  );

  const resultsCompleteForFiles = useMemo(() => {
    if (files.length === 0) return false;
    for (const file of files) {
      if (!resultByInputPath.has(file.path)) return false;
    }
    return true;
  }, [files, resultByInputPath]);

  type OutputNavMode = "inputs" | "results";
  const outputNavMode: OutputNavMode = resultsCompleteForFiles ? "results" : "inputs";

  const outputNavPaths = useMemo(() => {
    if (outputNavMode === "results") return results.map((result) => result.inputPath);
    return files.map((file) => file.path);
  }, [files, outputNavMode, results]);

  const selectedNavIndex = useMemo(() => {
    if (!selectedResultInputPath) return -1;
    return outputNavPaths.indexOf(selectedResultInputPath);
  }, [outputNavPaths, selectedResultInputPath]);

  const selectedNavPosition = selectedNavIndex >= 0 ? selectedNavIndex + 1 : 1;

  useEffect(() => {
    if (outputNavPaths.length === 0) {
      if (selectedResultInputPath !== null) {
        setSelectedResultInputPath(null);
      }
      return;
    }

    if (selectedResultInputPath && outputNavPaths.includes(selectedResultInputPath)) return;
    setSelectedResultInputPath(outputNavPaths[0] ?? null);
  }, [outputNavPaths, selectedResultInputPath]);

  const selectedInputPath = selectedResultInputPath;

  const selectedInputFile = useMemo(() => {
    if (!selectedInputPath) return null;
    return files.find((file) => file.path === selectedInputPath) ?? null;
  }, [files, selectedInputPath]);

  const selectedSavedResult = useMemo(() => {
    if (!selectedInputPath) return null;
    return resultByInputPath.get(selectedInputPath) ?? null;
  }, [resultByInputPath, selectedInputPath]);

  const isShowingSavedResult = outputNavMode === "results" && selectedSavedResult !== null;

  const selectedInputName = useMemo(() => {
    if (!selectedInputPath) return "";
    if (selectedInputFile?.name) return selectedInputFile.name;
    return selectedInputPath.replace(/\\/g, "/").split("/").pop() ?? selectedInputPath;
  }, [selectedInputFile?.name, selectedInputPath]);

  const selectedDisplayPath = useMemo(() => {
    if (isShowingSavedResult && selectedSavedResult?.ok && selectedSavedResult.outputPath) {
      return selectedSavedResult.outputPath;
    }
    return selectedInputPath;
  }, [isShowingSavedResult, selectedInputPath, selectedSavedResult]);

  const selectedDisplayName = useMemo(() => {
    if (!selectedDisplayPath) return "";
    return selectedDisplayPath.replace(/\\/g, "/").split("/").pop() ?? selectedDisplayPath;
  }, [selectedDisplayPath]);

  const selectedInputIsImage = useMemo(
    () => (selectedInputPath ? isImagePath(selectedInputPath) : false),
    [selectedInputPath],
  );

  const selectedFileSizePercent = useMemo(() => {
    if (!selectedInputPath) return sizePercent;
    return fileSizePercentByPath[selectedInputPath] ?? sizePercent;
  }, [fileSizePercentByPath, selectedInputPath, sizePercent]);

  const selectedCanvasSourcePath = selectedInputIsImage ? selectedInputPath : null;

  const selectedCanvasSourceSrc = useMemo(() => {
    if (!selectedCanvasSourcePath) return null;
    return convertFileSrc(selectedCanvasSourcePath);
  }, [selectedCanvasSourcePath]);

  useEffect(() => {
    if (!selectedInputIsImage || !selectedCanvasSourceSrc || !selectedCanvasSourcePath) {
      return;
    }

    const requestId = previewCompositeRequestIdRef.current + 1;
    previewCompositeRequestIdRef.current = requestId;
    let cancelled = false;

    (async () => {
      try {
        const [sourceImage, logoImage] = await Promise.all([
          loadImageElement(selectedCanvasSourceSrc),
          loadImageElement(logoPreviewSrc),
        ]);

        if (cancelled || requestId !== previewCompositeRequestIdRef.current) return;

        const sourceWidth = Math.max(1, sourceImage.naturalWidth || sourceImage.width || 1);
        const sourceHeight = Math.max(1, sourceImage.naturalHeight || sourceImage.height || 1);
        const scaleToClamp = Math.min(1, PREVIEW_MAX_SIDE_PX / Math.max(sourceWidth, sourceHeight));
        const previewWidth = Math.max(1, Math.round(sourceWidth * scaleToClamp));
        const previewHeight = Math.max(1, Math.round(sourceHeight * scaleToClamp));

        const shortSide = Math.min(previewWidth, previewHeight);
        const targetMax = Math.max(1, Math.round(shortSide * (selectedFileSizePercent / 100)));
        const logoNaturalWidth = Math.max(1, logoImage.naturalWidth || logoImage.width || 1);
        const logoNaturalHeight = Math.max(1, logoImage.naturalHeight || logoImage.height || 1);
        const logoMax = Math.max(logoNaturalWidth, logoNaturalHeight);
        const logoScale = targetMax / logoMax;
        const targetLogoWidth = Math.max(1, Math.round(logoNaturalWidth * logoScale));
        const targetLogoHeight = Math.max(1, Math.round(logoNaturalHeight * logoScale));
        const { x, y } = resolveCornerPosition(
          position,
          previewWidth,
          previewHeight,
          targetLogoWidth,
          targetLogoHeight,
        );

        const canvas = previewCanvasRef.current;
        if (!canvas) return;

        canvas.width = previewWidth;
        canvas.height = previewHeight;
        const context = canvas.getContext("2d");
        if (!context) {
          setSelectedPreviewImageFailedPath(selectedCanvasSourcePath);
          return;
        }

        context.clearRect(0, 0, previewWidth, previewHeight);
        context.drawImage(sourceImage, 0, 0, previewWidth, previewHeight);
        context.drawImage(logoImage, x, y, targetLogoWidth, targetLogoHeight);

        if (!cancelled && requestId === previewCompositeRequestIdRef.current) {
          setSelectedPreviewImageFailedPath(null);
        }
      } catch {
        if (!cancelled && requestId === previewCompositeRequestIdRef.current) {
          setSelectedPreviewImageFailedPath(selectedCanvasSourcePath);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    position,
    selectedFileSizePercent,
    selectedCanvasSourcePath,
    selectedCanvasSourceSrc,
    selectedInputIsImage,
  ]);

  const selectedResultCanRenderCanvas =
    selectedInputIsImage && Boolean(selectedCanvasSourcePath) && Boolean(selectedCanvasSourceSrc);

  const selectedPreviewImageFailed =
    selectedInputIsImage &&
    Boolean(selectedCanvasSourcePath) &&
    selectedPreviewImageFailedPath === selectedCanvasSourcePath;

  const applySelectedSizeToAll = useCallback(() => {
    const clamped = clampPercent(selectedFileSizePercent, DEFAULT_SETTINGS.sizePercent);

    setSettings((prev) => ({
      ...prev,
      sizePercent: clamped,
    }));
    setFileSizePercentByPath({});
  }, [selectedFileSizePercent]);

  const moveSelectedResult = useCallback((direction: -1 | 1) => {
    if (outputNavPaths.length === 0) return;

    const baseIndex = selectedNavIndex >= 0 ? selectedNavIndex : 0;
    const nextIndex = (baseIndex + direction + outputNavPaths.length) % outputNavPaths.length;
    const nextPath = outputNavPaths[nextIndex];
    if (!nextPath) return;
    setSelectedResultInputPath(nextPath);
  }, [outputNavPaths, selectedNavIndex]);

  return (
    <div className="cb-shell">
      <div className="cb-frame">
        <header className="cb-top">
          <div className="cb-brand">
            <div className="cb-mark" aria-hidden="true">
                {logoOk ? (
                  <img
                    src={headerIconSrc}
                    alt=""
                    onError={() => {
                      if (headerIconSrc === "/icon.png") {
                        setHeaderIconSrc("/logo.webp");
                        return;
                      }
                      setLogoOk(false);
                    }}
                  />
                ) : null}
              </div>
            <div className="cb-title">
              <h1>{strings.appName}</h1>
              <p>{strings.tagline}</p>
            </div>
          </div>
          <div className="cb-actions">
            <button
              className="cb-btn cb-btnPrimary"
              type="button"
              disabled={files.length === 0 || isProcessing}
              title={runHint}
               onClick={() => {
                 void runStampBatch();
               }}
             >
              {isProcessing ? strings.processing : strings.save}
            </button>
            {isProcessing ? (
              <button className="cb-btn" type="button" onClick={() => void requestCancelBatch()}>
                취소
              </button>
            ) : null}
          </div>
        </header>

        {updateDownload.active ? (
          <div className="cb-updateToast" role={UPDATE_TOAST_ROLE} aria-live="polite">
            <div className="cb-updateToastTitle">{strings.updateDownloading}</div>
            <div className="cb-updateToastLine">
              {updateDownload.percent !== null
                ? `${strings.updatePercentPrefix} ${updateDownload.percent}%`
                : strings.updatePercentUnknown}
            </div>
            {updateDownload.downloadedBytes !== null ? (
              <div className="cb-updateToastLine">
                {strings.updateBytesPrefix} {updateDownload.downloadedBytes.toLocaleString()}
                {updateDownload.totalBytes
                  ? ` / ${updateDownload.totalBytes.toLocaleString()} ${strings.updateBytesUnit}`
                  : ` ${strings.updateBytesUnit}`}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="cb-body">
          <main className="cb-mainCanvas" aria-label={strings.outputTitle}>
            <section className="cb-card cb-settingsOutputCard" aria-label={strings.outputTitle}>
              <div className="cb-cardHeader">
                <h2>{strings.outputTitle}</h2>
                <p>{strings.outputHelp}</p>
              </div>
              <div className="cb-cardBody">
                {files.length === 0 ? (
                  <div className="cb-note">{strings.placeholderRight}</div>
                ) : (
                  <>
                    {results.length > 0 ? (
                      <div className="cb-note cb-noteBottom">
                        {strings.resultSummaryPrefix} {resultSummary.success}
                        {strings.resultSummaryDivider}
                        {resultSummary.failure}
                        {strings.resultSummaryTail}
                        {resultSummary.total}
                        {strings.resultSummaryTotalUnit}
                      </div>
                    ) : null}

                    <div className="cb-outputLayout">
                      <div className="cb-outputPreviewPanel">
                        <div className="cb-outputPreviewHeader">
                          <div className="cb-minWidth0">
                            <div className="cb-ellipsis cb-outputPreviewTitle" title={selectedDisplayPath ?? undefined}>
                              {selectedDisplayName || strings.outputTitle}
                            </div>
                            <div className="cb-note cb-ellipsis" title={selectedInputPath ?? undefined}>
                              원본: {selectedInputName || "-"}
                            </div>
                          </div>
                          {isShowingSavedResult && selectedSavedResult ? (
                            <div className="cb-badge">
                              {selectedSavedResult.ok ? strings.resultSuccess : strings.resultFailure}
                            </div>
                          ) : (
                            <div className="cb-badge">미리보기</div>
                          )}
                        </div>

                        <div className="cb-outputPreviewControls">
                          <div className="cb-field cb-outputPreviewField">
                            <label htmlFor="cb-selected-size">로고 크기</label>
                            <input
                              id="cb-selected-size"
                              className="cb-range"
                              type="range"
                              min={1}
                              max={300}
                              step={1}
                              value={selectedFileSizePercent}
                              onChange={(event) => {
                                if (!selectedInputPath) return;
                                const nextSizePercent = Number(event.currentTarget.value);
                                const clamped = clampPercent(nextSizePercent, sizePercent);
                                setFileSizePercentByPath((prev) => ({
                                  ...prev,
                                  [selectedInputPath]: clamped,
                                }));
                              }}
                            />
                            <div className="cb-note cb-noteBlockTight">현재 선택: {selectedFileSizePercent}%</div>
                          </div>
                          <div className="cb-field cb-outputPreviewField">
                            <label htmlFor="cb-selected-position">삽입 위치</label>
                            <select
                              id="cb-selected-position"
                              className="cb-select"
                              value={position}
                              onChange={(event) => {
                                const nextPosition =
                                  event.currentTarget.value as CornerBrandSettings["position"];

                                setSettings((prev) => ({
                                  ...prev,
                                  position: nextPosition,
                                }));
                              }}
                            >
                              <option value="좌상단">좌상단</option>
                              <option value="우상단">우상단</option>
                              <option value="좌하단">좌하단</option>
                              <option value="우하단">우하단</option>
                            </select>
                          </div>
                          <button
                            className="cb-btn"
                            type="button"
                            disabled={isProcessing || files.length === 0}
                            onClick={applySelectedSizeToAll}
                          >
                            로고 크기 전체 적용
                          </button>
                        </div>

                        {selectedInputIsImage ? (
                          selectedResultCanRenderCanvas && !selectedPreviewImageFailed ? (
                            <button
                              type="button"
                              className="cb-outputPreviewImageButton"
                              onClick={() => {
                                if (!selectedDisplayPath) return;
                                setPreviewPath(selectedDisplayPath);
                                setPreviewName(selectedDisplayName);
                              }}
                            >
                              <canvas
                                ref={previewCanvasRef}
                                aria-label={selectedDisplayName}
                                className="cb-outputPreviewImage"
                              />
                            </button>
                          ) : (
                            <div className="cb-outputPreviewFallback">
                              <div className="cb-outputPreviewDocButton cb-outputPreviewDocStatic">
                                <span className="cb-outputPreviewDocText">
                                  {selectedResultCanRenderCanvas
                                    ? "미리보기를 불러오지 못했습니다."
                                    : "미리보기 불가"}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="cb-btn cb-outputPreviewOpenButton"
                                onClick={() => {
                                  if (!selectedDisplayPath) return;
                                  void openExternalPath(selectedDisplayPath);
                                }}
                              >
                                파일 열기
                              </button>
                            </div>
                          )
                        ) : (
                          <div className="cb-outputPreviewFallback">
                            {!isShowingSavedResult ? (
                              <div className="cb-note cb-noteBottom">
                                PDF는 저장하기 후 결과로 확인할 수 있습니다.
                              </div>
                            ) : null}
                            <div className="cb-outputPreviewDocButton cb-outputPreviewDocStatic">
                              <span className="cb-outputPreviewDocText">미리보기 불가</span>
                            </div>
                            <button
                              type="button"
                              className="cb-btn cb-outputPreviewOpenButton"
                              onClick={() => {
                                if (!selectedDisplayPath) return;
                                void openExternalPath(selectedDisplayPath);
                              }}
                            >
                              파일 열기
                            </button>
                          </div>
                        )}

                        {isShowingSavedResult && selectedSavedResult && !selectedSavedResult.ok ? (
                          <div className="cb-note cb-noteTop4">
                            {strings.errorLabel} {selectedSavedResult.error ?? strings.unknownError}
                          </div>
                        ) : null}
                      </div>

                      <section className="cb-outputCarousel" aria-label={strings.outputTitle}>
                        <div className="cb-outputCarouselNav">
                          <button
                            className="cb-btn"
                            type="button"
                            disabled={outputNavPaths.length <= 1}
                            onClick={() => moveSelectedResult(-1)}
                          >
                            이전
                          </button>
                          <div className="cb-note cb-outputCarouselCounter">
                            {outputNavPaths.length === 0
                              ? "0/0"
                              : `${selectedNavPosition}/${outputNavPaths.length}`}
                          </div>
                          <button
                            className="cb-btn"
                            type="button"
                            disabled={outputNavPaths.length <= 1}
                            onClick={() => moveSelectedResult(1)}
                          >
                            다음
                          </button>
                        </div>
                      </section>
                    </div>
                  </>
                )}
              </div>
            </section>
          </main>

          <aside className="cb-sidebar" aria-label={strings.settingsTitle}>
            <section className="cb-card" aria-label={strings.filesTitle}>
            <div className="cb-cardHeader">
              <h2>{strings.filesTitle}</h2>
              <p>{strings.filesHelp}</p>
            </div>
            <div className="cb-cardBody">
              <section className="cb-drop" aria-label={strings.dropTitle}>
                <strong>{strings.dropTitle}</strong>
                <span>{strings.dropHint}</span>
                {!logoOk ? <span>{strings.missingLogo}</span> : null}
              </section>

              {notice ? (
                <div
                  className={`cb-alert ${notice.kind === "error" ? "cb-alertError" : "cb-alertInfo"}`}
                  aria-live={notice.kind === "error" ? "assertive" : "polite"}
                >
                  {notice.message}
                </div>
              ) : null}

              <div className="cb-inlineButtons cb-inlineButtonsTop">
                <button className="cb-btn" type="button" disabled={isProcessing} onClick={pickFiles}>
                  {strings.pickFiles}
                </button>
                <button
                  className="cb-btn"
                  type="button"
                  disabled={files.length === 0 || isProcessing}
                  onClick={() => {
                    setFiles([]);
                    setResults([]);
                    setSelectedResultInputPath(null);
                    setFileSizePercentByPath({});
                  }}
                >
                  {strings.clearList}
                </button>
              </div>

              {isProcessing && progressTotal > 0 ? (
                <div className="cb-note cb-progressWrap">
                  <div>
                    {strings.progressStatus}: {progressDone} / {progressTotal}
                  </div>
                  <progress value={progressDone} max={progressTotal} className="cb-progressBar" />
                  {progressFileName ? (
                    <div className="cb-progressFile">
                      {strings.currentFileLabel} {progressFileName}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="cb-listScroll cb-listScrollFiles cb-scrollWrapFiles">
                <section className="cb-list" aria-label={strings.filesTitle}>
                  {files.length === 0 ? (
                    <div className="cb-listItem">
                      <div className="cb-minWidth0">{strings.placeholderRow}</div>
                      <div className="cb-badge">-</div>
                    </div>
                  ) : null}

                  {files.map((f) => (
                    <div className="cb-listItem" key={f.path}>
                      <button
                        className="cb-minWidth0 cb-ellipsis cb-fileNameButton"
                        type="button"
                        title={f.path}
                        onClick={() => {
                          void openPreviewOrPath(f.path, f.name);
                        }}
                      >
                        {f.name}
                      </button>
                      <div className="cb-listItemActions">
                        <div className="cb-badge">
                          {typeof f.ext === "string" && f.ext ? f.ext.toUpperCase() : "-"}
                        </div>
                        <button
                          className="cb-btn"
                          type="button"
                          disabled={isProcessing}
                          onClick={(event) => {
                            event.stopPropagation();
                            setFiles((prev) => prev.filter((x) => x.path !== f.path));
                            setResults((prev) => prev.filter((x) => x.inputPath !== f.path));
                            setFileSizePercentByPath((prev) => {
                              if (!(f.path in prev)) return prev;
                              const next = { ...prev };
                              delete next[f.path];
                              return next;
                            });
                            setSelectedResultInputPath((prev) => (prev === f.path ? null : prev));
                          }}
                          aria-label={strings.removeOne}
                          title={strings.removeOne}
                        >
                          {strings.removeOne}
                        </button>
                      </div>
                    </div>
                  ))}
                </section>
              </div>
            </div>
          </section>

            <section className="cb-card" aria-label={strings.settingsTitle}>
            <div className="cb-cardHeader">
              <h2>{strings.settingsTitle}</h2>
              <p>{strings.settingsHelp}</p>
            </div>
            <div className="cb-cardBody cb-settingsBody">
              <div className="cb-settingsGrid">
                <section className="cb-settingsSection" aria-label="로고/저장">
                  <h3 className="cb-settingsHeading">로고/저장</h3>

                  <div className="cb-card cb-settingsSubcard">
                    <div className="cb-cardHeader">
                      <h2>{strings.logoImageTitle}</h2>
                      <p>{strings.logoImageHelp}</p>
                    </div>
                    <div className="cb-cardBody">
                      <div className="cb-logoPreview cb-logoPreviewSpacing">
                        <img
                          src={logoPreviewSrc}
                          alt={strings.logoImageTitle}
                          className="cb-logoPreviewImage"
                          onError={(event) => {
                            const fallback = "/logo.webp";
                            if (event.currentTarget.src.endsWith(fallback)) {
                              return;
                            }
                            event.currentTarget.src = fallback;
                          }}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="cb-card cb-settingsSubcard">
                    <div className="cb-cardHeader">
                      <h2>{strings.outputDirTitle}</h2>
                      <p>{strings.outputDirHelp}</p>
                    </div>
                    <div className="cb-cardBody">
                      <div className="cb-inlineButtons">
                        <button
                          className="cb-btn"
                          type="button"
                          disabled={isProcessing}
                          onClick={pickOutputDir}
                        >
                          {strings.pickOutputDir}
                        </button>
                        <button
                          className="cb-btn"
                          type="button"
                          disabled={isProcessing}
                          onClick={() => setCustomOutputDir(null)}
                        >
                          {strings.useDefaultOutputDir}
                        </button>
                      </div>
                      <div className="cb-note cb-noteBlock" title={customOutputDir ?? strings.defaultOutputDir}>
                        {customOutputDir ?? strings.defaultOutputDir}
                      </div>
                    </div>
                  </div>
                </section>

              </div>
            </div>
            </section>
          </aside>
        </div>

        {previewImageSrc ? (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={previewName || strings.outputTitle}
            className="cb-previewOverlay"
          >
            <div className="cb-previewCard">
              <div className="cb-previewHeader">
                <div className="cb-ellipsis cb-previewTitle" title={previewPath ?? undefined}>
                  {previewName}
                </div>
                <button className="cb-btn" type="button" onClick={() => setPreviewPath(null)}>
                  X
                </button>
              </div>
              <img
                src={previewImageSrc}
                alt={previewName || strings.outputTitle}
                className="cb-previewImage"
              />
            </div>
          </div>
        ) : null}

        <footer className="cb-footer">
          <div className="cb-footerMeta">
            <div className="cb-note">{strings.footerRunStatus.replace("{count}", String(files.length))}</div>
            <div className="cb-note">위치: {position} / 크기: {sizePercent}%</div>
          </div>
          <div className="cb-footerUpdate">
            <div className="cb-note">
              {strings.appVersionLabel}: {appVersion}
            </div>
            <button
              className="cb-btn cb-btnFooter"
              type="button"
              disabled={isUpdateChecking || updateDownload.active}
              onClick={() => {
                void runUpdateCheck({ showNoUpdateNotice: true });
              }}
            >
              {strings.manualUpdateCheck}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default App;
