import { CanActivate, Controller, ExecutionContext, ForbiddenException, Get, Injectable, Post, Body, UnauthorizedException, BadRequestException, UseGuards, Res, Req, createParamDecorator } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';
import { Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString } from 'class-validator';
import type { AuthScope } from '@eveops/contracts';
import { PrismaService } from './prisma.service';
import { assertPortalRole } from './domain';
import { IsAcceptedPassword, IsNewPassword, passwordMatches } from './password-policy';

export const CurrentScope = createParamDecorator((_data: unknown, context: ExecutionContext) => context.switchToHttp().getRequest().scope);

export class LoginDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail()
  email!: string;

  @IsString()
  @IsAcceptedPassword()
  password!: string;

  @IsOptional()
  @IsIn(['OPERATIONS', 'GOVERNANCE'])
  portal: 'OPERATIONS' | 'GOVERNANCE' = 'OPERATIONS';
}

export class ChangePasswordDto {
  @IsString()
  @IsAcceptedPassword()
  currentPassword!: string;

  @IsString()
  @IsNewPassword()
  newPassword!: string;
}

const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  '/api/auth/me',
  '/api/auth/profile',
  '/api/auth/change-password',
  '/api/auth/logout',
]);

type ScopeShapeUser = {
  organizationId: string;
  role: AuthScope['role'];
  scopes: Array<{
    event: { organizationId: string };
    hallId: string | null;
    hall: { active: boolean } | null;
    stallId: string | null;
    stall: { active: boolean } | null;
    serviceType: string | null;
  }>;
};

export function assertValidScopeShape(user: ScopeShapeUser) {
  const scopes = user.scopes;
  const sameOrganization = scopes.every((item) => item.event.organizationId === user.organizationId);
  const valid =
    sameOrganization &&
    scopes.length > 0 &&
    (user.role === 'STALL'
      ? scopes.length === 1 && !!scopes[0].stallId && !!scopes[0].hallId && scopes[0].stall?.active === true && scopes[0].hall?.active === true
      : user.role === 'STAFF'
        ? scopes.every((item) => !!item.hallId && !!item.serviceType && item.hall?.active === true)
        : user.role === 'HALL_MANAGER'
          ? scopes.every((item) => !!item.hallId && item.hall?.active === true)
          : true);
  if (!valid) throw new UnauthorizedException('Account scope is invalid');
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const raw = request.cookies?.eveops_session ?? request.headers.authorization?.replace('Bearer ', '');
    if (!raw) throw new UnauthorizedException('Authentication required');
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            scopes: {
              include: {
                event: { select: { organizationId: true } },
                hall: { select: { eventId: true, active: true } },
                stall: { select: { eventId: true, active: true } },
              },
            },
          },
        },
      },
    });
    if (!session || session.expiresAt <= new Date() || session.user.status !== 'ACTIVE') throw new UnauthorizedException('Session expired');
    assertValidScopeShape(session.user);
    if (session.user.mustChangePassword) {
      const rawPath = String(request.originalUrl ?? request.url ?? '').split('?')[0];
      const path = rawPath.startsWith('/api/') ? rawPath : `/api${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}`;
      if (!PASSWORD_CHANGE_ALLOWED_PATHS.has(path)) {
        throw new ForbiddenException('Password change is required before continuing.');
      }
    }
    const scopes = session.user.scopes;
    request.sessionId = session.id;
    request.scope = {
      userId: session.user.id,
      role: session.user.role,
      eventIds: [...new Set(scopes.map((item) => item.eventId))],
      hallIds: scopes.flatMap((item) => item.hallId ? [item.hallId] : []),
      stallId: scopes.find((item) => item.stallId)?.stallId ?? undefined,
      serviceTypes: scopes.flatMap((item) => item.serviceType ? [item.serviceType] : []),
      mustChangePassword: session.user.mustChangePassword,
    };
    return true;
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = await this.prisma.user.findUnique({ where: { email: body.email } });
    const matches = await passwordMatches(body.password, user?.passwordHash);
    if (!user || !matches) throw new UnauthorizedException('Invalid credentials');
    if (user.approvalStatus === 'PENDING_APPROVAL') {
      throw new ForbiddenException('Your staff account is awaiting Admin approval.');
    }
    if (user.approvalStatus === 'REJECTED') {
      throw new ForbiddenException('Your staff account request was rejected.');
    }
    if (user.status !== 'ACTIVE') throw new UnauthorizedException('Invalid credentials');
    const portal = body.portal;
    assertPortalRole(user.role, portal);
    await this.prisma.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    const token = randomBytes(32).toString('base64url');
    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      },
    });
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    response.cookie('eveops_session', token, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: 'lax',
      expires: expiresAt,
      path: '/',
    });
    return {
      expiresAt,
      mustChangePassword: user.mustChangePassword,
      user: { id: user.id, name: user.name, role: user.role, mustChangePassword: user.mustChangePassword },
    };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentScope() scope: AuthScope & { mustChangePassword?: boolean }) {
    return scope;
  }

  @Get('profile')
  @UseGuards(SessionGuard)
  async profile(@CurrentScope() scope: AuthScope) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: scope.userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        mustChangePassword: true,
        scopes: {
          select: {
            event: { select: { id: true, name: true, timezone: true } },
            hall: { select: { id: true, code: true, name: true } },
            stall: {
              select: {
                id: true,
                stallCode: true,
                zone: { select: { id: true, code: true } },
              },
            },
            serviceType: true,
          },
        },
      },
    });
  }

  @Post('change-password')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async changePassword(
    @CurrentScope() scope: AuthScope,
    @Body() body: ChangePasswordDto,
    @Req() request: Request & { sessionId?: string },
  ) {
    if (body.newPassword === body.currentPassword) {
      throw new BadRequestException('New password must be different from the current password');
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: scope.userId } });
    if (!(await passwordMatches(body.currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    const passwordHash = await hash(body.newPassword, 12);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, mustChangePassword: false },
      });
      await tx.session.deleteMany({
        where: {
          userId: user.id,
          ...(request.sessionId ? { id: { not: request.sessionId } } : {}),
        },
      });
    });
    return { changed: true, mustChangePassword: false };
  }

  @Post('logout')
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const raw = request.cookies?.eveops_session;
    if (raw) {
      const tokenHash = createHash('sha256').update(raw).digest('hex');
      await this.prisma.session.deleteMany({ where: { tokenHash } });
    }
    response.clearCookie('eveops_session', {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: 'lax',
      path: '/',
    });
    return { signedOut: true };
  }
}

function cookieSecure() {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  return process.env.NODE_ENV === 'production';
}
