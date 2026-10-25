import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { redirectTarget, type FloatingLoginProvider } from '../../lib/floatingLogin';
import type { FloatingLoginController, FloatingLoginTab } from './useFloatingLogin';
import './floatingLogin.css';

export interface FloatingLoginModalProps {
  controller: FloatingLoginController;
  /** The admin's Live Preview: rendered in place, always open, never submitted. */
  inline?: boolean;
}

type Phase = 'closed' | 'open' | 'closing';
type FieldName = 'displayName' | 'email' | 'password' | 'confirm';

/** Must match the rwp-fl-out animation in styles.css. */
const closeDuration = 200;
const minPasswordLength = 6;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const focusable = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const headings: Record<FloatingLoginTab, [string, string]> = {
  login: ['Welcome back', 'Sign in to your account.'],
  register: ['Create an account', 'Fill in your details to get started.'],
  forgot: ['Reset your password', 'Enter your email and we will send you a link to choose a new password.'],
};

const submitLabels: Record<FloatingLoginTab, [string, string]> = {
  login: ['Sign in', 'Signing in…'],
  register: ['Create account', 'Creating account…'],
  forgot: ['Send reset link', 'Sending…'],
};

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const providerLabels: Record<FloatingLoginProvider, string> = { google: 'Google', facebook: 'Facebook' };

/** The provider marks are their own colours, so they are not inherited from the theme. */
function ProviderIcon({ provider }: { provider: FloatingLoginProvider }) {
  return provider === 'google' ? (
    <svg className="rwp-fl-social-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#4285f4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.24c1.89-1.74 2.98-4.3 2.98-7.35Z" />
      <path fill="#34a853" d="M12 22c2.7 0 4.96-.9 6.62-2.42l-3.24-2.5c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.58-4.12H3.06v2.58A10 10 0 0 0 12 22Z" />
      <path fill="#fbbc05" d="M6.42 13.92a6 6 0 0 1 0-3.84V7.5H3.06a10 10 0 0 0 0 9l3.36-2.58Z" />
      <path fill="#ea4335" d="M12 5.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87A10 10 0 0 0 3.06 7.5l3.36 2.58C7.2 7.72 9.4 5.96 12 5.96Z" />
    </svg>
  ) : (
    <svg className="rwp-fl-social-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#1877f2" d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.45 2.89h-2.33v6.99A10 10 0 0 0 22 12Z" />
    </svg>
  );
}

/**
 * The Log in / Register / Forgot password dialog. Portalled into <body>, so no transformed or
 * overflow-hidden ancestor can clip it, above the header layer (9800) like the other overlays.
 */
export default function FloatingLoginModal({ controller, inline = false }: FloatingLoginModalProps) {
  const {
    settings, isOpen, close, activeTab, setActiveTab, canRegister, providers, busyProvider, loading, errorMessage,
    notice, successMessage, login, signInWithProvider, register, forgotPassword,
  } = controller;
  const uid = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const focusFieldOnSwitch = useRef(false);
  const [phase, setPhase] = useState<Phase>(inline || isOpen ? 'open' : 'closed');
  const [fields, setFields] = useState<Record<FieldName, string>>({ displayName: '', email: '', password: '', confirm: '' });
  const [showProblems, setShowProblems] = useState(false);

  // Stays mounted while the closing animation plays.
  useEffect(() => {
    if (inline) return undefined;
    if (isOpen) {
      setPhase('open');
      return undefined;
    }
    setPhase((current) => (current === 'closed' ? 'closed' : 'closing'));
    const timer = window.setTimeout(() => setPhase('closed'), reducedMotion() ? 0 : closeDuration);
    return () => window.clearTimeout(timer);
  }, [inline, isOpen]);

  // While open: Esc closes, the page behind does not scroll, and focus goes back where it was.
  useEffect(() => {
    if (inline || !isOpen) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = 'hidden';
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const frame = window.requestAnimationFrame(() => {
      (dialogRef.current?.querySelector<HTMLElement>('.rwp-fl-panel input') || dialogRef.current)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      root.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [inline, isOpen, close]);

  // Passwords never carry over to another tab; the email does, since it is usually the same.
  useEffect(() => {
    setFields((current) => ({ ...current, password: '', confirm: '' }));
    setShowProblems(false);
    // The "Forgot password?" / "Back to sign in" link that was clicked is gone now.
    if (focusFieldOnSwitch.current) {
      focusFieldOnSwitch.current = false;
      dialogRef.current?.querySelector<HTMLElement>('.rwp-fl-panel input')?.focus();
    }
  }, [activeTab]);

  // Open renders straight away; only closing waits for the animation.
  const state: Phase = inline || isOpen ? 'open' : phase;
  if (state === 'closed') return null;

  const email = fields.email.trim();
  const problems: Record<FieldName, string> = {
    displayName: '',
    email: !email ? 'Enter your email address.' : emailPattern.test(email) ? '' : 'That is not a complete email address (name@example.com).',
    password: activeTab === 'forgot' ? ''
      : !fields.password ? 'Enter a password.'
        : activeTab === 'register' && fields.password.length < minPasswordLength ? `Use at least ${minPasswordLength} characters.` : '',
    confirm: activeTab === 'register' && fields.confirm !== fields.password ? 'The two passwords do not match.' : '',
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading || successMessage) return;
    setShowProblems(true);
    const invalid = (Object.keys(problems) as FieldName[]).find((name) => problems[name]);
    if (invalid) {
      document.getElementById(`${uid}-${invalid}`)?.focus();
      return;
    }
    if (activeTab === 'login') void login(email, fields.password);
    else if (activeTab === 'register') void register(fields.displayName, email, fields.password);
    else void forgotPassword(email);
  };

  const switchTo = (tab: FloatingLoginTab) => {
    focusFieldOnSwitch.current = true;
    setActiveTab(tab);
  };

  const tabs: FloatingLoginTab[] = canRegister ? ['login', 'register'] : ['login'];
  const showTabs = activeTab !== 'forgot' && tabs.length > 1;

  // Two tabs, so any arrow key moves to the other one (and the same key works in RTL).
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.indexOf(activeTab);
    const next = event.key === 'Home' ? tabs[0]
      : event.key === 'End' ? tabs[tabs.length - 1]
        : ['ArrowLeft', 'ArrowRight'].includes(event.key) ? tabs[(index + 1) % tabs.length] : null;
    if (!next) return;
    event.preventDefault();
    setActiveTab(next);
    document.getElementById(`${uid}-tab-${next}`)?.focus();
  };

  // Keeps Tab inside the dialog.
  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (inline || event.key !== 'Tab' || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>(focusable)].filter((item) => item.getClientRects().length > 0);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const field = (name: FieldName, label: string, type: string, autoComplete: string, hint?: string) => {
    const id = `${uid}-${name}`;
    const problem = showProblems ? problems[name] : '';
    const describedBy = [problem && `${id}-problem`, hint && `${id}-hint`].filter(Boolean).join(' ');
    return (
      <div className="rwp-fl-field">
        <label className="rwp-fl-label" htmlFor={id}>{label}</label>
        <input
          id={id} name={name} type={type} autoComplete={autoComplete} className="rwp-fl-input"
          value={fields[name]} readOnly={loading} aria-invalid={problem ? true : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => setFields((current) => ({ ...current, [name]: event.target.value }))}
        />
        {hint && !problem && <span id={`${id}-hint`} className="rwp-fl-hint">{hint}</span>}
        {problem && <span id={`${id}-problem`} className="rwp-fl-field-error">{problem}</span>}
      </div>
    );
  };

  const [heading, subtitle] = headings[activeTab];
  const [submitLabel, busyLabel] = submitLabels[activeTab];
  const target = redirectTarget(settings.floating_login_redirect_url);
  const providerList = (Object.keys(providerLabels) as FloatingLoginProvider[]).filter((provider) => providers[provider]);

  const body = successMessage ? (
    <div className="rwp-fl-success" role="status">
      <span className="rwp-fl-success-icon" aria-hidden="true">✓</span>
      <p className="rwp-fl-success-title">{successMessage}</p>
      <p className="rwp-fl-muted">{target ? `Taking you to ${target}…` : 'Reloading this page…'}</p>
      <span className="rwp-fl-spinner" aria-hidden="true" />
    </div>
  ) : (
    <>
      {showTabs && (
        <div className="rwp-fl-tabs" role="tablist" aria-label="Account">
          {tabs.map((tab) => (
            <button
              key={tab} id={`${uid}-tab-${tab}`} type="button" role="tab" className="rwp-fl-tab"
              aria-selected={activeTab === tab} aria-controls={`${uid}-panel`} tabIndex={activeTab === tab ? 0 : -1}
              onClick={() => setActiveTab(tab)} onKeyDown={onTabKeyDown}
            >
              {tab === 'login' ? 'Log in' : 'Register'}
            </button>
          ))}
        </div>
      )}

      <form
        key={activeTab} id={`${uid}-panel`} className="rwp-fl-panel" noValidate onSubmit={submit}
        role={showTabs ? 'tabpanel' : undefined} aria-labelledby={showTabs ? `${uid}-tab-${activeTab}` : undefined}
      >
        {errorMessage && <div className="rwp-fl-alert rwp-fl-alert--error" role="alert">{errorMessage}</div>}
        {notice && <div className="rwp-fl-alert rwp-fl-alert--notice" role="status">{notice}</div>}

        {activeTab !== 'forgot' && providerList.length > 0 && (
          <div className="rwp-fl-social">
            <div className="rwp-fl-social-buttons">
              {providerList.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  className={`rwp-fl-social-button rwp-fl-social-button--${provider}`}
                  disabled={loading}
                  aria-busy={busyProvider === provider || undefined}
                  onClick={() => void signInWithProvider(provider)}
                >
                  {busyProvider === provider
                    ? <span className="rwp-fl-spinner rwp-fl-spinner--small" aria-hidden="true" />
                    : <ProviderIcon provider={provider} />}
                  {busyProvider === provider
                    ? `Opening ${providerLabels[provider]}…`
                    : `Continue with ${providerLabels[provider]}`}
                </button>
              ))}
            </div>
            <p className="rwp-fl-divider"><span>or use your email</span></p>
          </div>
        )}

        {activeTab === 'register' && field('displayName', 'Display name (optional)', 'text', 'name')}
        {field('email', 'Email', 'email', activeTab === 'login' ? 'username' : 'email')}
        {activeTab === 'login' && field('password', 'Password', 'password', 'current-password')}
        {activeTab === 'register' && field('password', 'Password', 'password', 'new-password', `At least ${minPasswordLength} characters.`)}
        {activeTab === 'register' && field('confirm', 'Confirm password', 'password', 'new-password')}

        <button type="submit" className="rwp-fl-submit" disabled={loading} aria-busy={loading || undefined}>
          {loading && <span className="rwp-fl-spinner rwp-fl-spinner--small" aria-hidden="true" />}
          {loading ? busyLabel : submitLabel}
        </button>

        <p className="rwp-fl-links">
          {activeTab === 'login' && (
            <button type="button" className="rwp-fl-link" onClick={() => switchTo('forgot')}>Forgot password?</button>
          )}
          {activeTab === 'forgot' && (
            <button type="button" className="rwp-fl-link" onClick={() => switchTo('login')}>Back to sign in</button>
          )}
          {activeTab === 'register' && (
            <>Already have an account?{' '}<button type="button" className="rwp-fl-link" onClick={() => switchTo('login')}>Sign in</button></>
          )}
        </p>
      </form>
    </>
  );

  const layer = (
    <div
      className={`rwp-fl rwp-fl-theme-${settings.floating_login_theme} rwp-fl-layer${inline ? ' rwp-fl-layer--inline' : ''}`}
      data-state={state}
    >
      {!inline && <div className="rwp-fl-backdrop" aria-hidden="true" onClick={close} />}
      <div
        ref={dialogRef} className="rwp-fl-dialog" tabIndex={-1} onKeyDown={trapFocus}
        role={inline ? 'group' : 'dialog'} aria-modal={inline ? undefined : true}
        aria-labelledby={`${uid}-title`} aria-describedby={`${uid}-subtitle`}
      >
        <button type="button" className="rwp-fl-close" aria-label="Close" onClick={close}>
          <span aria-hidden="true">×</span>
        </button>
        <h2 id={`${uid}-title`} className="rwp-fl-title">{successMessage ? 'Done' : heading}</h2>
        <p id={`${uid}-subtitle`} className="rwp-fl-muted rwp-fl-subtitle">{successMessage ? '' : subtitle}</p>
        {body}
      </div>
    </div>
  );

  return inline ? layer : createPortal(layer, document.body);
}
