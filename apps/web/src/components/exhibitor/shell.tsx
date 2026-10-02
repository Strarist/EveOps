'use client';

import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ServerClockProvider } from '@/lib/server-clock';
import { clearPushForLogout, releaseWorkAlerts } from '@/lib/work-alerts';
import { useConnection, useStallProfile } from './data';

export function ExhibitorShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { connection, pulse } = useConnection();
  const { profile, error: profileError, reload } = useStallProfile(connection + pulse);
  const scope = profile?.scopes.find((item) => item.stall);
  const stallCode = scope?.stall?.stallCode;
  const place = scope?.stall
    ? [scope.hall?.name, 'Zone ' + scope.stall.zone.code, 'Stall ' + scope.stall.stallCode].filter(Boolean).join(' / ')
    : '';
  const connectionLabel = connection === 'live' ? 'Live' : connection === 'reconnecting' ? 'Reconnecting' : 'Connecting';

  async function logout() {
    await clearPushForLogout();
    releaseWorkAlerts();
    await globalThis.fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    router.replace('/login');
    router.refresh();
  }

  return (
    <ServerClockProvider>
      <div className="mobile-page exhibitor-page">
        <main className="mobile-shell exhibitor">
          <header className="exhibitor-header">
            <div>
              <p className="eyebrow">{scope?.event.name ?? 'Your event'}</p>
              <h1>{stallCode ? `Stall ${stallCode}` : 'Your stall'}</h1>
              {place ? <p className="exhibitor-place">{place}</p> : null}
            </div>
            <p className={'exhibitor-connection connection-' + connection} role="status">{connectionLabel}</p>
          </header>
          {profileError && !profile ? <p className="form-error" role="alert">{profileError} <button type="button" onClick={() => void reload()}>Try again</button></p> : null}
          {children}
          <nav className="bottom-nav exhibitor-nav" aria-label="Stall navigation">
            <a href="/stall" aria-current={pathname === '/stall' ? 'page' : undefined}>Home</a>
            <a href="/stall/requests" aria-current={pathname.startsWith('/stall/requests') || pathname.startsWith('/stall/ticket') ? 'page' : undefined}>Requests</a>
            <a href="/stall/request" aria-current={pathname === '/stall/request' ? 'page' : undefined}>New</a>
            <a href="/stall/profile" aria-current={pathname === '/stall/profile' ? 'page' : undefined}>Profile</a>
            <button type="button" className="logout" onClick={() => void logout()}>Sign out</button>
          </nav>
        </main>
      </div>
    </ServerClockProvider>
  );
}
