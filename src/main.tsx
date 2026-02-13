import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/global.css";
import { strings } from "./ui/strings";

type RootErrorBoundaryProps = {
  children: React.ReactNode;
  onError: (message: string) => void;
};

class RootErrorBoundary extends React.Component<RootErrorBoundaryProps> {
  componentDidCatch(error: Error) {
    this.props.onError(error.message || String(error));
  }

  render() {
    return this.props.children;
  }
}

function normalizeErrorMessage(input: unknown): string {
  if (input instanceof Error) return input.message || String(input);
  if (typeof input === "string") return input;
  if (input == null) return strings.unknownError;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function FatalErrorScreen({ message }: { message: string }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <section
        style={{
          width: "min(680px, 100%)",
          background: "var(--cb-surface-strong)",
          border: "1px solid var(--cb-border-strong)",
          borderRadius: 16,
          boxShadow: "var(--cb-shadow)",
          padding: 20,
        }}
      >
        <h1 style={{ margin: 0 }}>{strings.fatalTitle}</h1>
        <p style={{ marginTop: 10, marginBottom: 0 }}>{strings.fatalGuide}</p>
        <pre
          style={{
            marginTop: 14,
            marginBottom: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--cb-danger)",
            background: "rgba(155, 44, 44, 0.08)",
            borderRadius: 12,
            border: "1px solid rgba(155, 44, 44, 0.2)",
            padding: 12,
            fontFamily: "var(--cb-font-sans)",
          }}
        >
          {strings.fatalErrorLabel} {message || strings.unknownError}
        </pre>
      </section>
    </div>
  );
}

function RootApp() {
  const [fatalMessage, setFatalMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    const onWindowError = (event: ErrorEvent) => {
      setFatalMessage((prev) => prev ?? normalizeErrorMessage(event.error ?? event.message));
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      setFatalMessage((prev) => prev ?? normalizeErrorMessage(event.reason));
    };

    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  if (fatalMessage) return <FatalErrorScreen message={fatalMessage} />;

  return (
    <RootErrorBoundary onError={(message) => setFatalMessage(normalizeErrorMessage(message))}>
      <App />
    </RootErrorBoundary>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>,
);
