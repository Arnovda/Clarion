import type { Metadata } from 'next';
import { Manrope, Inter, Source_Serif_4 } from 'next/font/google';
import localFont from 'next/font/local';
import './globals.css';
import { Toaster } from '@/components/ui/Toast';

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

// The display serif. Loaded through next/font so it is fetched ONCE at build
// time and served from this origin — the browser never contacts Google
// (assessment 4-2: the privacy policy says "functional storage only" while
// globals.css hotlinked fonts.googleapis.com on every page). Inter and
// Manrope were already self-hosted the same way; Geist Mono is a local file.
const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  axes: ['opsz'],
  variable: '--font-source-serif',
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
    <html lang="en" className={`${manrope.variable} ${inter.variable} ${sourceSerif.variable} ${geistMono.variable}`}>
      <body suppressHydrationWarning className="antialiased font-sans bg-bg text-ink">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
