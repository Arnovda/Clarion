'use client';

/**
 * Shared layout for auth pages (login, register, forgot/reset password).
 * Centered card on a tonal gradient background — outside the three-panel AppShell.
 */
export default function AuthLayout({
  subtitle,
  children,
}: {
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface relative">
      {/* Background tonal gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-surface via-surface-container-low to-surface-container opacity-80" />

      <div className="relative w-full max-w-sm z-10">
        {/* Logo + tagline */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-xl gradient-primary flex items-center justify-center">
              <span className="text-white font-headline font-bold text-lg">D</span>
            </div>
            <span className="font-headline text-headline-md font-bold text-on-surface">DataBridge</span>
          </div>
          <p className="text-body-md text-on-surface-variant">{subtitle}</p>
        </div>

        {/* Card */}
        <div className="bg-surface-container-lowest rounded-2xl shadow-ambient p-8">
          {children}
        </div>

        {/* Footer */}
        <p className="text-center text-label-sm text-on-surface-variant/40 mt-8">
          Powered by Claude AI
        </p>
      </div>
    </div>
  );
}
