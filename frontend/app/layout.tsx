import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DataBridge',
  description: 'AI-powered semantic data platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
