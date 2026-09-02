import type { Metadata } from 'next';
import { Manrope, Inter } from 'next/font/google';
import localFont from 'next/font/local';
import './globals.css';
import { Toaster } from '@/components/ui/Toast';
import { I18nProvider } from '@/lib/i18n';

const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-manrope',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const geistMono = localFont({
  src: './fonts/GeistMonoVF.woff',
  variable: '--font-geist-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Clarion',
  description: 'AI-powered semantic data platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // lang="en" is only the server-rendered shell — the I18nProvider stamps
    // the ACTIVE locale onto <html> the moment it resolves (browser guess,
    // then the signed-in user's stored preference). See lib/i18n/index.tsx.
    <html lang="en" className={`${manrope.variable} ${inter.variable} ${geistMono.variable}`}>
      <body suppressHydrationWarning className="antialiased font-sans bg-bg text-ink">
        {/* Mounted ONCE, above every page and both copies of the app chrome
            (the FeaturesProvider lesson, solved by construction). */}
        <I18nProvider>
          {children}
          <Toaster />
        </I18nProvider>
      </body>
    </html>
  );
}
