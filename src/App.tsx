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

function getPathExtension(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const ext = normalized.split(".").pop();
  return ext ? ext.toLowerCase() : "";
}

function isImagePath(path: string) {
  return IMAGE_EXTENSIONS.has(getPathExtension(path));
}

function isTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
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
  const [customLogoPath, setCustomLogoPath] = useState<string | null>(null);
  const [customOutputDir, setCustomOutputDir] = useState<string | null>(null);

  const [files, setFiles] = useState<InputFile[]>([]);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressTotal, setProgressTotal] = useState(0);
  const [progressDone, setProgressDone] = useState(0);
  const [progressFileName, setProgressFileName] = useState<string | null>(null);
  const [results, setResults] = useState<StampFileResult[]>([]);
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

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        unlisten = await getCurrentWindow().listen<{ paths: string[] }>(
          "tauri://drag-drop",
          (event) => {
            setFiles((prev) => {
              const { next, rejected } = addPathsUnique(prev, event.payload.paths);
              if (rejected.length) setNotice({ kind: "info", message: strings.unsupportedFiles });
              return next;
            });
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
  }, []);

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

  function createRequestId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

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
      setFiles((prev) => {
        const { next, rejected } = addPathsUnique(prev, paths);
        if (rejected.length) setNotice({ kind: "info", message: strings.unsupportedFiles });
        return next;
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      setNotice({
        kind: "error",
        message: detail ? `${strings.pickerFailed} ${detail}` : strings.pickerFailed,
      });
    }
  }

  async function pickLogoFile() {
    setNotice(null);
    try {
      const result = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "이미지", extensions: ["jpg", "jpeg", "png", "webp"] }],
      });

      if (!result || Array.isArray(result)) return;
      setCustomLogoPath(result);
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

  async function runStampBatch() {
    if (files.length === 0 || isProcessing) return;
    setNotice(null);
    setIsProcessing(true);
    setProgressTotal(files.length);
    setProgressDone(0);
    setProgressFileName(null);

    const requestId = createRequestId();
    activeRequestIdRef.current = requestId;

    try {
      const stampResults = await invoke<StampFileResult[]>("stamp_batch_progress", {
        paths: files.map((f) => f.path),
        settings: {
          position,
          sizePercent,
          marginPercent: 0,
        },
        logoPath: customLogoPath,
        outputDir: customOutputDir,
        requestId,
      });
      setResults(stampResults);
    } catch (error) {
      const detail = typeof error === "string" ? error : strings.runFailed;
      setNotice({ kind: "error", message: `${strings.runFailed} ${detail}` });
      setResults([]);
    } finally {
      activeRequestIdRef.current = null;
      setProgressTotal(0);
      setProgressDone(0);
      setProgressFileName(null);
      setIsProcessing(false);
    }
  }

  async function openPreviewOrPath(path: string, name: string) {
    if (isImagePath(path)) {
      setPreviewPath(path);
      setPreviewName(name);
      return;
    }

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

  const runHint = useMemo(() => {
    if (files.length === 0) return "파일을 먼저 추가하세요";
    return isProcessing ? strings.processing : strings.run;
  }, [files.length, isProcessing]);

  const resultSummary = useMemo(() => {
    const total = results.length;
    const success = results.filter((result) => result.ok).length;
    const failure = total - success;
    return { total, success, failure };
  }, [results]);

  const logoPreviewSrc = useMemo(
    () => (customLogoPath ? convertFileSrc(customLogoPath) : "/logo.webp"),
    [customLogoPath],
  );

  const previewImageSrc = useMemo(
    () => (previewPath ? convertFileSrc(previewPath) : null),
    [previewPath],
  );

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
              onClick={runStampBatch}
            >
              {isProcessing ? strings.processing : strings.run}
            </button>
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

          <aside className="cb-card" aria-label={strings.settingsTitle}>
            <div className="cb-cardHeader">
              <h2>{strings.settingsTitle}</h2>
              <p>{strings.settingsHelp}</p>
            </div>
            <div className="cb-cardBody cb-settingsBody">
              <div className="cb-settingsGrid">
                <div className="cb-card cb-settingsOutputCard">
                  <div className="cb-cardHeader">
                    <h2>{strings.outputTitle}</h2>
                    <p>{strings.outputHelp}</p>
                  </div>
                  <div className="cb-cardBody">
                    {results.length === 0 ? (
                      <div className="cb-note">{strings.placeholderRight}</div>
                    ) : (
                      <>
                        <div className="cb-note cb-noteBottom">
                          {strings.resultSummaryPrefix} {resultSummary.success}
                          {strings.resultSummaryDivider}
                          {resultSummary.failure}
                          {strings.resultSummaryTail}
                          {resultSummary.total}
                          {strings.resultSummaryTotalUnit}
                        </div>
                        <div className="cb-listScroll cb-listScrollOutput cb-scrollWrapOutput">
                          <section className="cb-list" aria-label={strings.outputTitle}>
                            {results.map((result) => {
                              const inputFileName =
                                result.inputPath.replace(/\\/g, "/").split("/").pop() ?? result.inputPath;
                              const outputFileName = result.outputPath
                                ? result.outputPath.replace(/\\/g, "/").split("/").pop() ?? result.outputPath
                                : inputFileName;
                              const primaryFileName =
                                result.ok && result.outputPath ? outputFileName : inputFileName;

                              return (
                                <button
                                  className="cb-listItem cb-outputListButton"
                                  key={result.inputPath}
                                  type="button"
                                  onClick={() => {
                                    if (result.ok && result.outputPath) {
                                      void openPreviewOrPath(result.outputPath, outputFileName);
                                      return;
                                    }
                                    void openPreviewOrPath(result.inputPath, inputFileName);
                                  }}
                                >
                                  <div className="cb-minWidth0">
                                    <div className="cb-ellipsis" title={primaryFileName}>
                                      {primaryFileName}
                                    </div>
                                    {!result.ok ? (
                                      <div className="cb-note cb-noteTop4">
                                        {strings.errorLabel} {result.error ?? strings.unknownError}
                                      </div>
                                    ) : null}
                                  </div>
                                  <div className="cb-badge">
                                    {result.ok ? strings.resultSuccess : strings.resultFailure}
                                  </div>
                                </button>
                              );
                            })}
                          </section>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <section className="cb-settingsSection" aria-label="로고/저장">
                  <h3 className="cb-settingsHeading">로고/저장</h3>

                  <div className="cb-card cb-settingsSubcard">
                    <div className="cb-cardHeader">
                      <h2>{strings.logoImageTitle}</h2>
                      <p>{strings.logoImageHelp}</p>
                    </div>
                    <div className="cb-cardBody">
                      <div className="cb-inlineButtons">
                        <button
                          className="cb-btn"
                          type="button"
                          disabled={isProcessing}
                          onClick={pickLogoFile}
                        >
                          {strings.pickLogoFile}
                        </button>
                        <button
                          className="cb-btn"
                          type="button"
                          disabled={isProcessing}
                          onClick={() => setCustomLogoPath(null)}
                        >
                          {strings.useDefaultLogo}
                        </button>
                      </div>
                      <div className="cb-note cb-noteBlock" title={customLogoPath ?? strings.defaultLogoPath}>
                        {customLogoPath ?? strings.defaultLogoPath}
                      </div>
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

                <section className="cb-settingsSection" aria-label="실행 설정">
                  <h3 className="cb-settingsHeading">실행 설정</h3>

                  <div className="cb-card cb-settingsSubcard">
                    <div className="cb-cardBody cb-settingsFields">
                      <div className="cb-field">
                        <label htmlFor="cb-position">{strings.positionLabel}</label>
                        <select
                          id="cb-position"
                          className="cb-select"
                          value={position}
                          onChange={(e) =>
                            setSettings((prev) => ({
                              ...prev,
                              position: e.currentTarget.value as CornerBrandSettings["position"],
                            }))
                          }
                        >
                          <option value="좌상단">좌상단</option>
                          <option value="우상단">우상단</option>
                          <option value="좌하단">좌하단</option>
                          <option value="우하단">우하단</option>
                        </select>
                      </div>

                      <div className="cb-field">
                        <label htmlFor="cb-size">{strings.sizeLabel}</label>
                        <input
                          id="cb-size"
                          className="cb-range"
                          type="range"
                          min={1}
                          max={50}
                          step={1}
                          value={sizePercent}
                          onChange={(e) => {
                            const nextSizePercent = Number(e.currentTarget.value);
                            setSettings((prev) => ({
                              ...prev,
                              sizePercent: Number.isFinite(nextSizePercent)
                                ? Math.min(50, Math.max(1, Math.round(nextSizePercent)))
                                : DEFAULT_SETTINGS.sizePercent,
                            }));
                          }}
                        />
                        <div className="cb-note cb-noteBlockTight">
                          현재 선택: {sizePercent}%
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

              </div>
            </div>
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
