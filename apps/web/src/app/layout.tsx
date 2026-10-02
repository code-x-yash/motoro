import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/lib/auth';
import { I18nProvider } from '@/lib/i18n';
import { PwaRegister } from '@/components/pwa-register';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Motoro — 24×7 roadside assistance & mechanic dispatch',
    template: '%s · Motoro',
  },
  description:
    'Motoro dispatches the nearest verified mechanic, workshop or tow truck to your breakdown with live tracking, transparent quotes and 24×7 operations oversight.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Motoro',
  openGraph: {
    type: 'website',
    siteName: 'Motoro',
    title: 'Motoro — 24×7 roadside assistance & mechanic dispatch',
    description:
      'Motoro dispatches the nearest verified mechanic, workshop or tow truck to your breakdown with live tracking, transparent quotes and 24×7 operations oversight.',
    url: 'https://motoro-web.vercel.app',
  },
  twitter: {
    card: 'summary',
    title: 'Motoro — 24×7 roadside assistance & mechanic dispatch',
    description:
      'Nearest verified mechanic or tow truck dispatched to your breakdown, with live tracking and transparent quotes.',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
  other: {
    'apple-mobile-web-app-capable': 'yes',
    'mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-status-bar-style': 'default',
    'application-name': 'Motoro',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ffd100',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <I18nProvider>
          <AuthProvider>
            {children}
            <PwaRegister />
          </AuthProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
