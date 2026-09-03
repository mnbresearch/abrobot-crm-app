import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The last line of defence.
 *
 * React 18 unmounts the entire tree on an uncaught render error. Without a
 * boundary the user gets a blank white page — no message, no reload button,
 * nothing in the UI to explain it, and no signal to us that it happened. A
 * customer's only move is to phone support and say "it's gone white".
 *
 * That is not a hypothetical. The audit found several live paths that can
 * throw during render: a malformed date in the Calendar (RangeError from
 * toISOString), `automations.conditions` arriving as an object rather than an
 * array, a null `profile.role` in the app shell, and a health-check response
 * missing `checks`. Each of those turns into a white screen today.
 *
 * A boundary cannot make those bugs go away, but it turns "the app is gone"
 * into "this screen broke, here is a way back" — which is the difference
 * between a support call and a shrug.
 */

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Console is the only sink today. When an error reporter is added, this is
    // the one place that needs to change.
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={{ maxWidth: 560, margin: "12vh auto", padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>Something went wrong on this screen</h1>
        <p style={{ color: "#78716c", lineHeight: 1.6, marginBottom: 20 }}>
          Your data is safe — this is a display problem, not a data one. Reloading
          usually clears it. If it keeps happening, tell us what you were doing and
          we'll fix it.
        </p>

        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <button
            className="btn btn-primary"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
          <button
            className="btn"
            onClick={() => { window.location.href = "/"; }}
          >
            Go to dashboard
          </button>
        </div>

        {/* Collapsed by default: useful when someone asks the customer to send
            a screenshot, without making a scary stack trace the main event. */}
        <details style={{ marginTop: 24, textAlign: "left" }}>
          <summary style={{ cursor: "pointer", color: "#78716c", fontSize: 13 }}>
            Technical details
          </summary>
          <pre
            style={{
              marginTop: 10, padding: 12, background: "#f5f5f4", borderRadius: 8,
              fontSize: 12, overflow: "auto", maxHeight: 200, whiteSpace: "pre-wrap",
            }}
          >
            {error.name}: {error.message}
          </pre>
        </details>
      </div>
    );
  }
}
