import ShellLayout from '@/components/layout/ShellLayout';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <ShellLayout>{children}</ShellLayout>;
}
