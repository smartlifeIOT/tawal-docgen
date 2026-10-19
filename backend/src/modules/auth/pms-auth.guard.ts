import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { ALL_PERMISSIONS, DEFAULT_PM_PERMISSIONS, type PermissionMap } from './permissions';

/**
 * Accepts a token issued by PMS.
 *
 * DocGen runs as a module of PMS rather than a separate product, so there is no
 * second login. PMS signs the JWT; this verifies it with the same secret and
 * mirrors the user into DocGen's own table so that packages, batches and
 * documents still have a local `createdBy` to point at.
 *
 * The mirror is deliberately thin — email, name and role. PMS stays the system
 * of record for who exists and what they may do; DocGen never edits it.
 */
@Injectable()
export class PmsAuthGuard implements CanActivate {
  private readonly logger = new Logger(PmsAuthGuard.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const header = String(req.headers?.authorization ?? '');
    if (!header.startsWith('Bearer ')) {
      throw new UnauthorizedException('No token supplied.');
    }

    const secret = this.config.get<string>('JWT_SECRET');
    let claims: any;
    try {
      claims = await this.jwt.verifyAsync(header.slice(7), { secret });
    } catch {
      throw new UnauthorizedException('The session has expired. Sign in to PMS again.');
    }

    const email = String(claims?.email ?? '').trim().toLowerCase();
    if (!email) {
      throw new UnauthorizedException('The token carries no email.');
    }

    req.user = await this.mirror(email, claims);
    return true;
  }

  /**
   * Keeps a local row in step with the PMS account.
   *
   * Permissions come from the token when PMS sends them. An admin gets
   * everything; anyone else with no permissions recorded yet gets the default
   * set, so a new PMS user can work without an extra setup step.
   */
  private async mirror(email: string, claims: any) {
    const role = String(claims?.role ?? '').trim();
    const isAdmin = /^admin$/i.test(role);

    /*
     * Only what the token actually carries overwrites the stored map. A token
     * without a permissions claim used to fall through to the PM defaults and
     * write them over whatever an admin had set, on every single request — so
     * granting a permission looked like it had no effect. Absent means "no
     * opinion", not "reset to defaults".
     */
    const claimed: PermissionMap | undefined = isAdmin
      ? ALL_PERMISSIONS
      : (claims?.permissions as PermissionMap | undefined);

    const existing = await this.prisma.user.findUnique({ where: { email } });

    const user = existing
      ? await this.prisma.user.update({
          where: { email },
          data: {
            name: claims?.name ?? existing.name,
            role: isAdmin ? 'ADMIN' : 'PM',
            ...(claimed !== undefined ? { permissions: claimed as any } : {}),
            isActive: true,
          },
        })
      : await this.prisma.user.create({
          data: {
            email,
            name: claims?.name ?? email,
            // PMS holds the password; this row can never be signed into
            // directly, so it gets no usable hash.
            passwordHash: 'pms-managed',
            role: isAdmin ? 'ADMIN' : 'PM',
            // A brand-new mirrored account still needs a starting set, so that
            // a first-time PMS user can work without a separate setup step.
            permissions: (claimed ?? DEFAULT_PM_PERMISSIONS) as any,
            isActive: true,
            mustChangePassword: false,
          },
        });

    if (!existing) {
      this.logger.log(`Mirrored PMS user ${email} (${isAdmin ? 'ADMIN' : 'PM'})`);
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      permissions: (user.permissions ?? {}) as PermissionMap,
    };
  }
}
