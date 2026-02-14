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
    <div className="cb-fatal-wrap">
      <section className="cb-fatal-card">
        <h1 className="cb-fatal-title">{strings.fatalTitle}</h1>
        <p className="cb-fatal-guide">{strings.fatalGuide}</p>
        <pre className="cb-fatal-error">
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
