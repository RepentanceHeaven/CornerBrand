import { useEffect, useMemo, useRef, useState } from "react";
import "./styles/app.css";
import { strings } from "./ui/strings";
import { open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
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

function App() {
  const [logoOk, setLogoOk] = useState(true);
  const [headerIconSrc, setHeaderIconSrc] = useState("/icon.png");
  const [settings, setSettings] = useState<CornerBrandSettings>(DEFAULT_SETTINGS);
  const [customLogoPath, setCustomLogoPath] = useState<string | null>(null);
  const [customOutputDir, setCustomOutputDir] = useState<string | null>(null);

  const [files, setFiles] = useState<InputFile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressTotal, setProgressTotal] = useState(0);
  const [progressDone, setProgressDone] = useState(0);
  const [progressFileName, setProgressFileName] = useState<string | null>(null);
  const [results, setResults] = useState<StampFileResult[]>([]);
  const activeRequestIdRef = useRef<string | null>(null);
  const updateCheckStartedRef = useRef(false);
  const [updateDownload, setUpdateDownload] = useState<UpdateDownloadState>({
    active: false,
    percent: null,
    downloadedBytes: null,
    totalBytes: null,
  });

  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (updateCheckStartedRef.current) return;
    updateCheckStartedRef.current = true;

    (async () => {
      try {
        const update = await check();
        if (!update) return;

        const plainNotes = (update.body ?? "").replace(/\s+/g, " ").trim();
        const notes =
          plainNotes.length > 280 ? `${plainNotes.slice(0, 280)}...` : plainNotes || strings.updateNoNotes;
        const shouldInstall = window.confirm(
          strings.updateConfirm
            .replace("{version}", update.version)
            .replace("{notes}", notes),
        );

        if (!shouldInstall) {
          await update.close();
          return;
        }

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
        window.alert(strings.updateInstalled);
        await update.close();
      } catch {
        if (import.meta.env.DEV) {
          setNotice((prev) => prev ?? strings.updateCheckFailed);
        }
      }
    })();
  }, []);

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
              if (rejected.length) setNotice(strings.unsupportedFiles);
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
        if (rejected.length) setNotice(strings.unsupportedFiles);
        return next;
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      setNotice(detail ? `${strings.pickerFailed} ${detail}` : strings.pickerFailed);
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
      setNotice(detail ? `${strings.pickerFailed} ${detail}` : strings.pickerFailed);
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
      setNotice(detail ? `${strings.pickerFailed} ${detail}` : strings.pickerFailed);
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
      setNotice(`${strings.runFailed} ${detail}`);
      setResults([]);
    } finally {
      activeRequestIdRef.current = null;
      setProgressTotal(0);
      setProgressDone(0);
      setProgressFileName(null);
      setIsProcessing(false);
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
            <button className="cb-btn" type="button" onClick={pickFiles}>
              {strings.pickFiles}
            </button>
            <button
              className="cb-btn cb-btnPrimary"
              type="button"
              disabled={files.length === 0 || isProcessing}
              title={runHint}
              onClick={runStampBatch}
            >
              {isProcessing ? strings.processing : strings.run}
            </button>
            {updateDownload.active ? (
              <div
                className="cb-note"
                style={{
                  marginTop: 8,
                  padding: "6px 10px",
                  borderRadius: 10,
                  border: "1px solid var(--cb-line)",
                  background: "var(--cb-panel)",
                  maxWidth: 280,
                }}
              >
                <div>{strings.updateDownloading}</div>
                <div>
                  {updateDownload.percent !== null
                    ? `${strings.updatePercentPrefix} ${updateDownload.percent}%`
                    : strings.updatePercentUnknown}
                </div>
                {updateDownload.downloadedBytes !== null ? (
                  <div>
                    {strings.updateBytesPrefix} {updateDownload.downloadedBytes.toLocaleString()}
                    {updateDownload.totalBytes
                      ? ` / ${updateDownload.totalBytes.toLocaleString()} ${strings.updateBytesUnit}`
                      : ` ${strings.updateBytesUnit}`}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </header>

        <div className="cb-body">
          <section className="cb-card" aria-label={strings.filesTitle}>
            <div className="cb-cardHeader">
              <h2>{strings.filesTitle}</h2>
              <p>{strings.filesHelp}</p>
            </div>
            <div className="cb-cardBody">
              <div className="cb-drop" role="region" aria-label={strings.dropTitle}>
                <strong>{strings.dropTitle}</strong>
                <span>{strings.dropHint}</span>
                {!logoOk ? <span>{strings.missingLogo}</span> : null}
              </div>

              {notice ? (
                <div className="cb-note" style={{ marginTop: 10, color: "var(--cb-danger)" }}>
                  {notice}
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
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
                <div className="cb-note" style={{ marginTop: 10 }}>
                  <div>
                    {strings.progressStatus}: {progressDone} / {progressTotal}
                  </div>
                  <progress value={progressDone} max={progressTotal} style={{ width: "100%", marginTop: 6 }} />
                  {progressFileName ? (
                    <div style={{ marginTop: 6 }}>
                      {strings.currentFileLabel} {progressFileName}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="cb-list" aria-label="파일 목록">
                {files.length === 0 ? (
                  <div className="cb-listItem">
                    <div style={{ minWidth: 0 }}>{strings.placeholderRow}</div>
                    <div className="cb-badge">-</div>
                  </div>
                ) : null}

                {files.map((f) => (
                  <div className="cb-listItem" key={f.path}>
                    <div
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={f.path}
                    >
                      {f.name}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div className="cb-badge">
                        {typeof f.ext === "string" && f.ext ? f.ext.toUpperCase() : "-"}
                      </div>
                      <button
                        className="cb-btn"
                        type="button"
                        disabled={isProcessing}
                        onClick={() => {
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
              </div>
            </div>
          </section>

          <aside className="cb-card" aria-label={strings.settingsTitle}>
            <div className="cb-cardHeader">
              <h2>{strings.settingsTitle}</h2>
              <p>{strings.settingsHelp}</p>
            </div>
            <div className="cb-cardBody">
              <div className="cb-card" style={{ borderRadius: 14, marginBottom: 12 }}>
                <div className="cb-cardHeader">
                  <h2>{strings.logoImageTitle}</h2>
                  <p>{strings.logoImageHelp}</p>
                </div>
                <div className="cb-cardBody">
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
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
                  <div className="cb-note" style={{ marginTop: 10 }} title={customLogoPath ?? strings.defaultLogoPath}>
                    {customLogoPath ?? strings.defaultLogoPath}
                  </div>
                </div>
              </div>

              <div className="cb-card" style={{ borderRadius: 14, marginBottom: 12 }}>
                <div className="cb-cardHeader">
                  <h2>{strings.outputDirTitle}</h2>
                  <p>{strings.outputDirHelp}</p>
                </div>
                <div className="cb-cardBody">
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
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
                  <div
                    className="cb-note"
                    style={{ marginTop: 10 }}
                    title={customOutputDir ?? strings.defaultOutputDir}
                  >
                    {customOutputDir ?? strings.defaultOutputDir}
                  </div>
                </div>
              </div>

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
                <div className="cb-note" style={{ marginTop: 8 }}>
                  현재 선택: {sizePercent}%
                </div>
              </div>

              <div className="cb-card" style={{ borderRadius: 14 }}>
                <div className="cb-cardHeader">
                  <h2>{strings.outputTitle}</h2>
                  <p>{strings.outputHelp}</p>
                </div>
                <div className="cb-cardBody">
                  {results.length === 0 ? (
                    <div className="cb-note">{strings.placeholderRight}</div>
                  ) : (
                    <>
                      <div className="cb-note" style={{ marginBottom: 10 }}>
                        {strings.resultSummaryPrefix} {resultSummary.success}
                        {strings.resultSummaryDivider}
                        {resultSummary.failure}
                        {strings.resultSummaryTail}
                        {resultSummary.total}
                        {strings.resultSummaryTotalUnit}
                      </div>
                      <div className="cb-list" aria-label={strings.outputTitle}>
                        {results.map((result) => (
                          <div className="cb-listItem" key={result.inputPath}>
                            <div style={{ minWidth: 0 }}>
                              <div
                                style={{
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                                title={result.inputPath}
                              >
                                {result.inputPath.replace(/\\/g, "/").split("/").pop()}
                              </div>
                              <div className="cb-note" style={{ marginTop: 4 }}>
                                {result.ok
                                  ? `${strings.outputPathLabel} ${result.outputPath ?? "-"}`
                                  : `${strings.errorLabel} ${result.error ?? strings.unknownError}`}
                              </div>
                            </div>
                            <div className="cb-badge">
                              {result.ok ? strings.resultSuccess : strings.resultFailure}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </aside>
        </div>

        <footer className="cb-footer">
          <div className="cb-note">{strings.footerRunStatus.replace("{count}", String(files.length))}</div>
          <div className="cb-note">위치: {position} / 크기: {sizePercent}%</div>
        </footer>
      </div>
    </div>
  );
}

export default App;
