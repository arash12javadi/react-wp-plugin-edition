import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { tryGetSupabaseClient } from '../../../src/lib/db';
import { floatingLoginShowsTrigger, getFloatingLoginState, subscribeFloatingLogin } from '../../../src/lib/floatingLogin';
import { t } from '../../../src/lib/i18n';
import { useChatSettings } from '../lib/settings';
import { useChatSubject } from '../lib/subject';
import ChatWidget from './ChatWidget';

/**
 * The floating launcher: the bubble in the corner, the panel it opens, and the proactive nudge.
 *
 * Rendered into core's `after_footer` layout zone by the plugin's register(), so it appears on
 * every public page without core knowing the chatbot exists, and disappears the moment the
 * plugin is switched off.
 *
 * Floating Login is core and owns the corner while a visitor can sign in. The two share
 * `floatingLoginShowsTrigger`, so they swap rather than stack: a signed-out visitor sees the
 * Login / Register button, and the moment the session arrives that button goes, this launcher
 * takes the corner, and it hides again on sign-out. On the account pages — where the button is
 * hidden — the launcher is in the corner for everyone. Switching Floating Login off hands it the
 * corner too, because then there is no button to make room for.
 *
 * Proactive triggers are a nudge, never a takeover. A speech bubble appears above the launcher
 * after the configured delay, or when the pointer leaves towards the top of the window (the
 * usual "about to close the tab" signal). Once it has been dismissed or the chat has been
 * opened, this browser is not nudged again for the rest of the session — sessionStorage, not
 * localStorage, so it starts fresh on the next visit rather than never nudging again.
 */

const NUDGE_KEY = 'rwp_chat_nudged';

const nudgedAlready = () => {
  try {
    return sessionStorage.getItem(NUDGE_KEY) === '1';
  } catch {
    return false;
  }
};

const rememberNudge = () => {
  try {
    sessionStorage.setItem(NUDGE_KEY, '1');
  } catch {
    // Storage blocked; the nudge may show once more on the next page. Harmless.
  }
};

export interface ChatLauncherProps {
  /** Cart and product pages can hurry the nudge along; see the abandoned-cart setting. */
  urgent?: boolean;
  /**
   * The words beside the robot, from the shortcode or a builder widget. Empty is a valid choice:
   * the launcher is then the round robot on its own.
   */
  label?: string;
}

export default function ChatLauncher({ urgent = false, label: labelOverride }: ChatLauncherProps) {
  const { settings, ready } = useChatSettings();
  const [open, setOpen] = useState(false);
  const [nudge, setNudge] = useState('');
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const opened = useRef(false);
  // Announced by whatever rendered the page (see lib/subject.ts). Null on an ordinary page,
  // which is not a problem: the session still records the URL the visitor was on.
  const context = useChatSubject();
  const label = (labelOverride ?? settings.chat_launcher_label).trim();

  // The session the floating login listens to as well. null means "not read yet": the launcher
  // waits rather than flashing the robot at a signed-out visitor and pulling it away again.
  useEffect(() => {
    const supabase = tryGetSupabaseClient();
    if (!supabase) {
      setSignedIn(false);
      return undefined;
    }
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setSignedIn(Boolean(data.session?.user));
    }).catch(() => {
      if (active) setSignedIn(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) setSignedIn(Boolean(session?.user));
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  // One corner, two buttons: while Floating Login would draw its button there, the launcher stays
  // out of the way. The helper knows about the account pages and the signed-in visitor too, so this
  // is a swap rather than a corner comparison. The store is read through useSyncExternalStore, so
  // the options finishing loading — or changing in another tab — re-renders this at once instead of
  // spending a frame with both bubbles in the corner.
  //
  // No auth client means no button that can sign anyone in, so the launcher keeps the corner even
  // where the saved settings say Floating Login is on.
  const loginState = useSyncExternalStore(subscribeFloatingLogin, getFloatingLoginState);
  const authAvailable = useMemo(() => Boolean(tryGetSupabaseClient()), []);
  const loginOwnsCorner = authAvailable && signedIn !== null && floatingLoginShowsTrigger(loginState.settings, {
    signedIn,
    pathname: window.location.pathname,
  });

  const dismissNudge = useCallback(() => {
    setNudge('');
    rememberNudge();
  }, []);

  const openPanel = useCallback(() => {
    opened.current = true;
    setOpen(true);
    dismissNudge();
  }, [dismissNudge]);

  // Time on page, and exit intent.
  const proactive = settings.chat_proactive_enabled && ready && !nudgedAlready();
  const cartPrompt = settings.chat_cart_prompt_enabled && urgent && ready && !nudgedAlready();
  const message = cartPrompt ? settings.chat_cart_prompt_message : settings.chat_proactive_message;
  const delay = (cartPrompt ? settings.chat_cart_prompt_delay : settings.chat_proactive_delay) * 1000;

  useEffect(() => {
    if (!settings.chat_enabled || (!proactive && !cartPrompt) || open) return undefined;
    const show = () => {
      if (opened.current || nudgedAlready()) return;
      setNudge(message);
    };
    const timer = window.setTimeout(show, delay);
    const onLeave = (event: MouseEvent) => {
      // Only upwards: sideways and downwards are scrollbars, the dock and the taskbar.
      if (event.clientY <= 0 && settings.chat_proactive_exit_intent) show();
    };
    document.addEventListener('mouseout', onLeave);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mouseout', onLeave);
    };
  }, [cartPrompt, delay, message, open, proactive, settings.chat_enabled, settings.chat_proactive_exit_intent]);

  // A launcher with no session state yet, or one whose corner belongs to Floating Login, draws
  // nothing at all: no bubble, no nudge, no fixed wrapper left behind.
  if (!ready || !settings.chat_enabled || signedIn === null || loginOwnsCorner) return null;

  return (
    <div className={`rwp-chat rwp-chat-theme-${settings.chat_theme} rwp-chat-pos-${settings.chat_position}`}>
      {nudge && !open && (
        <div className="rwp-chat-nudge" role="status" onClick={openPanel}>
          <button type="button" className="rwp-chat-nudge-close"
            aria-label={t('chat.nudge.dismiss', 'Dismiss')}
            onClick={(event) => { event.stopPropagation(); dismissNudge(); }}>✕</button>
          {nudge}
        </div>
      )}

      {open ? (
        <ChatWidget settings={settings} placement="floating" context={context} live onClose={() => setOpen(false)} />
      ) : null}

      <button
        type="button"
        className={`rwp-chat-launcher${open ? ' rwp-chat-launcher--open' : ''}${label ? '' : ' rwp-chat-launcher--round'}`}
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-expanded={open}
        aria-label={open ? t('chat.close', 'Close the chat') : label || t('chat.open', 'Open the chat')}
      >
        <span className="rwp-chat-launcher-icon" aria-hidden="true">{open ? '✕' : '🤖'}</span>
        {label && <span className="rwp-chat-launcher-text">{open ? t('chat.close', 'Close') : label}</span>}
        {!open && <span className="rwp-chat-launcher-ping" aria-hidden="true" />}
      </button>
    </div>
  );
}
