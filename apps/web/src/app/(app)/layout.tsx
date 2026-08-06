import { AppShell } from '@/components/app-shell';

/**
 * Everything inside this route group is signed-in surface, so it all wears the
 * sidebar-and-header shell. `/login` sits outside the group and keeps the
 * full-bleed auth stage instead — which is why the group exists rather than a
 * conditional in the root layout.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
