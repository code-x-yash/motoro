'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

/** sessionStorage is per-tab-session → the sheet shows at most once per session. */
const SESSION_FLAG = 'motoro:pwa-install-shown';
const SHOW_DELAY_MS = 1800;

function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function hasSeenThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_FLAG) === '1';
  } catch {
    /* private mode / storage disabled → be conservative, do not nag */
    return true;
  }
}

function markSeenThisSession(): void {
  try {
    window.sessionStorage.setItem(SESSION_FLAG, '1');
  } catch {
    /* ignore */
  }
}

export function PwaRegister() {
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);
  const deferredRef = useRef<InstallPromptEvent | null>(null);
  const timerRef = useRef<number | null>(null);

  const hide = useCallback(() => setVisible(false), []);

  const scheduleShow = useCallback(() => {
    if (timerRef.current !== null) return;
    if (hasSeenThisSession() || isStandaloneDisplay()) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (!deferredRef.current) return;
      if (hasSeenThisSession() || isStandaloneDisplay()) return;
      // Flag is written the moment the sheet appears → once per session, ever.
      markSeenThisSession();
      setVisible(true);
    }, SHOW_DELAY_MS);
  }, []);

  useEffect(() => {
    setReady(true);

    if ('serviceWorker' in navigator) {
      // Registered in dev too: Chrome only fires beforeinstallprompt for pages
      // controlled by a service worker with a fetch handler.
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* offline / unsupported → silently ignore */
      });
    }

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      deferredRef.current = event as InstallPromptEvent;
      scheduleShow();
    };

    const onAppInstalled = () => {
      markSeenThisSession();
      deferredRef.current = null;
      setVisible(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setVisible(false);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [scheduleShow]);

  const install = useCallback(async () => {
    const deferred = deferredRef.current;
    if (!deferred) {
      setVisible(false);
      return;
    }
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      /* prompt dismissed or unsupported */
    }
    deferredRef.current = null;
    setVisible(false);
  }, []);

  if (!ready || !visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Dismiss install prompt"
        onClick={hide}
        className="absolute inset-0 cursor-default bg-ink/40 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Install Motoro"
        className="animate-pop-in relative w-full max-w-md rounded-t-2xl bg-sun-400 p-5 text-ink shadow-pop sm:rounded-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <img
            src="/icon.svg"
            alt=""
            width={56}
            height={56}
            className="h-14 w-14 rounded-2xl bg-white/70 ring-1 ring-ink/10"
          />
          <button
            type="button"
            aria-label="Close"
            onClick={hide}
            className="-mr-1 -mt-1 rounded-full p-2 text-ink/60 transition hover:bg-ink/10 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <h2 className="mt-4 text-xl font-bold tracking-tight">Install Motoro</h2>
        <p className="mt-1 text-sm text-ink/70">
          1-tap roadside help, live tracking and offline access
        </p>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            autoFocus
            onClick={install}
            className="rounded-2xl bg-ink px-5 py-3 text-sm font-semibold text-white transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-sun-400"
          >
            Install
          </button>
          <button
            type="button"
            onClick={hide}
            className="rounded-2xl px-5 py-3 text-sm font-semibold text-ink/70 ring-1 ring-inset ring-ink/15 transition hover:bg-ink/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
