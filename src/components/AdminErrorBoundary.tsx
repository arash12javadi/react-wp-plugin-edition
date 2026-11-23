import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render error from whichever admin screen is on display and shows it in place, instead
 * of the whole admin — sidebar, toolbar, everything — going blank white with nothing to click.
 *
 * There was no error boundary anywhere in the app before this: React only unmounts on an uncaught
 * render error when nothing catches it, and nothing did. That is the actual mechanism behind
 * "the page goes blank and needs a refresh" — some render threw, and by the time you see the blank
 * page the stack trace that would explain why is already gone from the screen (it is still in the
 * browser console, which is the first place to look when this fires again).
 *
 * Deliberately narrow: this wraps the one admin screen currently on display (App.tsx, around
 * {content}), not the whole app. A crash in one screen still leaves the sidebar and navigation
 * usable, so the way out is "click something else in the sidebar", not "reload and lose your place".
 *
 * App.tsx passes `key={`${section}:${subsection}`}`, not a children-reference check: JSX creates a
 * new `children` object on every render regardless of section, so comparing references would clear
 * the caught error (and briefly flash the broken screen again) on completely unrelated re-renders.
 * A key change is what actually remounts this boundary — the one way to legitimately reset it.
 */
interface State {
  error: Error | null;
}

const RELOAD_FLAG = 'rwp-chunk-reload';

/** Browsers word a failed lazy import differently; match the common messages. */
function isChunkLoadError(error: Error): boolean {
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|Loading chunk .* failed/i
    .test(`${error.name} ${error.message}`);
}

export default class AdminErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The boundary's own UI shows the message; the stack trace is only useful in the console.
    console.error('Admin screen crashed:', error, info.componentStack);
    // A screen's chunk is gone after a new deploy (hashed file names change) while this tab still
    // runs the old build. React.lazy caches the failed import, so "try again" can never succeed:
    // reload once to pick up the new build. The session flag stops a reload loop if the file is
    // genuinely missing or the network is down.
    if (isChunkLoadError(error)) {
      try {
        if (sessionStorage.getItem(RELOAD_FLAG) !== '1') {
          sessionStorage.setItem(RELOAD_FLAG, '1');
          window.location.reload();
          return;
        }
      } catch { /* storage blocked: fall through to the manual message */ }
    }
  }

  componentDidMount() {
    // Re-arm the one-time reload only after the screen has stayed up for a while, so a chunk that
    // is truly missing cannot loop (mount -> fail -> reload -> mount ...).
    this.rearm = window.setTimeout(() => {
      try { sessionStorage.removeItem(RELOAD_FLAG); } catch { /* ignore */ }
    }, 30000);
  }

  componentWillUnmount() {
    window.clearTimeout(this.rearm);
  }

  private rearm = 0;

  render() {
    if (!this.state.error) return this.props.children;
    if (isChunkLoadError(this.state.error)) {
      return (
        <div role="alert" style={{
          margin: '24px', padding: '20px 24px', borderRadius: '10px',
          border: '1px solid #f5c2c7', background: '#fdf2f2', color: '#842029',
        }}>
          <h2 style={{ margin: '0 0 8px' }}>A new version of the site is available</h2>
          <p style={{ margin: '0 0 12px' }}>Reload the page to load this screen.</p>
          <button type="button" onClick={() => window.location.reload()}
            style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #842029', background: '#fff', cursor: 'pointer' }}>
            Reload
          </button>
        </div>
      );
    }
    return (
      <div role="alert" style={{
        margin: '24px', padding: '20px 24px', borderRadius: '10px',
        border: '1px solid #f5c2c7', background: '#fdf2f2', color: '#842029',
      }}>
        <h2 style={{ margin: '0 0 8px' }}>This screen hit an error and could not finish rendering</h2>
        <p style={{ margin: '0 0 12px' }}>
          The rest of the admin is unaffected — use the sidebar to go elsewhere, or reload this screen.
        </p>
        <pre style={{
          margin: '0 0 12px', padding: '10px', borderRadius: '6px', background: '#fff',
          overflowX: 'auto', fontSize: '0.85em',
        }}>
          {this.state.error.message}
        </pre>
        <button type="button" onClick={() => this.setState({ error: null })}
          style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #842029', background: '#fff', cursor: 'pointer' }}>
          Try rendering this screen again
        </button>
      </div>
    );
  }
}
