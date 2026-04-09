import type { Metadata } from 'next';
import { Manrope, Inter } from 'next/font/google';
import localFont from 'next/font/local';
import './globals.css';

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
  title: 'DataBridge',
  description: 'AI-powered semantic data platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${inter.variable} ${geistMono.variable}`}>
      <body className="antialiased font-body bg-surface text-on-surface">{children}</body>
    </html>
  );
}
