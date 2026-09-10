import { NextRequest, NextResponse } from 'next/server';
import type { Role } from '@eveops/contracts';

const roleRoutes: Record<string, Role> = {
  '/stall': 'STALL',
  '/staff': 'STAFF',
  '/hall-manager': 'HALL_MANAGER',
  '/admin': 'ADMIN',
  '/super-admin': 'SUPER_ADMIN',
};

const homeByRole: Record<Role, string> = {
  STALL: '/stall',
  STAFF: '/staff',
  HALL_MANAGER: '/hall-manager',
  ADMIN: '/admin',
  SUPER_ADMIN: '/super-admin',
};

export async function proxy(request: NextRequest) {
  const expectedRole = Object.entries(roleRoutes).find(([path]) =>
    request.nextUrl.pathname === path || request.nextUrl.pathname.startsWith(path + '/'),
  )?.[1];

  if (!expectedRole) return NextResponse.next();

  const session = request.cookies.get('eveops_session');
  if (!session) {
    const loginUrl = new URL(expectedRole === 'SUPER_ADMIN' ? '/governance-access' : '/login', request.url);
    loginUrl.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  try {
    const apiUrl = process.env.API_URL ?? 'http://localhost:4000/api';
    const response = await fetch(apiUrl + '/auth/me', {
      headers: { cookie: request.headers.get('cookie') ?? '' },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Session rejected');
    const scope = (await response.json()) as { role: Role; mustChangePassword?: boolean };
    if (scope.mustChangePassword && !request.nextUrl.pathname.startsWith('/change-password')) {
      return NextResponse.redirect(new URL('/change-password', request.url));
    }
    if (scope.role !== expectedRole) {
      return NextResponse.redirect(new URL(homeByRole[scope.role] ?? '/login', request.url));
    }
    return NextResponse.next();
  } catch {
    const loginUrl = new URL(expectedRole === 'SUPER_ADMIN' ? '/governance-access' : '/login', request.url);
    loginUrl.searchParams.set('next', request.nextUrl.pathname);
    const redirect = NextResponse.redirect(loginUrl);
    redirect.cookies.delete('eveops_session');
    return redirect;
  }
}

export const config = {
  matcher: ['/stall/:path*', '/staff/:path*', '/hall-manager/:path*', '/admin/:path*', '/super-admin/:path*'],
};
