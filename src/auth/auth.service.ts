import { Injectable, Logger, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import { PasswordReset, PasswordResetDocument } from './entities/password-reset.entity';
import { SystemMailerService } from '../billing/system-mailer.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { TenantsService } from '../tenants/tenants.service';
import { InvitationsService } from '../users/invitations.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AcceptInviteDto } from '../users/dto/accept-invite.dto';
import { UserRole } from '../users/entities/user.entity';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { MembershipsService } from '../memberships/memberships.service';
import { AccountRole } from '../memberships/entities/account-member.entity';
import { BillingService } from '../billing/billing.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private usersService: UsersService,
    private tenantsService: TenantsService,
    private invitationsService: InvitationsService,
    private workspacesService: WorkspacesService,
    private membershipsService: MembershipsService,
    private billingService: BillingService,
    private jwtService: JwtService,
    private configService: ConfigService,
    @InjectModel(PasswordReset.name)
    private passwordResetModel: Model<PasswordResetDocument>,
    private mailer: SystemMailerService,
  ) {}

  private toAccountRole(role: string): AccountRole {
    if (role === UserRole.ADMIN) return AccountRole.ADMIN;
    if (role === UserRole.MANAGER) return AccountRole.MANAGER;
    if (role === UserRole.AGENT) return AccountRole.AGENT;
    return AccountRole.VIEWER;
  }

  async register(registerDto: RegisterDto) {
    const slug =
      registerDto.companySlug ||
      registerDto.companyName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    const initialBilling = this.billingService.buildInitialSubscription(
      registerDto.planKey || 'starter',
      registerDto.billingCycle || 'monthly',
    );

    const tenant = await this.tenantsService.create({
      name: registerDto.companyName,
      slug,
      plan: initialBilling.plan.key as any,
      billingCycle: registerDto.billingCycle || 'monthly',
    });

    await this.tenantsService.update((tenant as any)._id.toString(), {
      plan: initialBilling.plan.key as any,
      status: initialBilling.tenantStatus as any,
      trialEndsAt: initialBilling.trialEndsAt,
      limits: initialBilling.plan.limits,
      subscription: initialBilling.subscription,
    } as any);

    const user = await this.usersService.create({
      email: registerDto.email,
      password: registerDto.password,
      firstName: registerDto.firstName,
      lastName: registerDto.lastName,
      tenantId: (tenant as any)._id.toString(),
      role: UserRole.ADMIN,
    });

    const tenantId = (tenant as any)._id.toString();
    const userId = (user as any)._id.toString();

    // No workspace is created here on purpose: a new account starts with only the user's own
    // data (profile, plan) and creates its first company/workspace from the onboarding screen.
    await this.membershipsService.ensureAccountMember({
      tenantId,
      userId,
      role: AccountRole.OWNER,
    });

    const payload = {
      email: user.email,
      sub: (user as any)._id,
      tenantId: (tenant as any)._id,
      role: UserRole.ADMIN,
    };

    const tokens = this.generateTokens(payload);

    return {
      ...tokens,
      user: {
        id: (user as any)._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: UserRole.ADMIN,
        tenantId: (tenant as any)._id,
      },
      tenant: {
        id: (tenant as any)._id,
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.plan,
      },
    };
  }

  async login(loginDto: LoginDto) {
    const user = await this.usersService.findByEmail(loginDto.email);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(
      loginDto.password,
      user.password,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = {
      email: user.email,
      sub: (user as any)._id,
      tenantId: user.tenantId,
      role: user.role,
    };

    const tokens = this.generateTokens(payload);

    return {
      ...tokens,
      user: {
        id: (user as any)._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        tenantId: user.tenantId,
      },
    };
  }

  private generateTokens(payload: any) {
    const accessTokenSecret = this.configService.get<string>('jwt.secret');
    const refreshTokenSecret = this.configService.get<string>('jwt.refreshSecret');
    
    return {
      access_token: this.jwtService.sign(payload, {
        secret: accessTokenSecret,
        expiresIn: '1h',
      } as any),
      refresh_token: this.jwtService.sign(payload, {
        secret: refreshTokenSecret,
        expiresIn: '7d',
      } as any),
    };
  }

  async acceptInvite(acceptInviteDto: AcceptInviteDto) {
    const invitation = await this.invitationsService.findByToken(acceptInviteDto.token);

    let user = await this.usersService.findByEmail(invitation.email);
    const tenantId = (invitation.tenantId as any)._id?.toString() || invitation.tenantId.toString();

    if (!user) {
      user = await this.usersService.create({
        email: invitation.email,
        password: acceptInviteDto.password,
        firstName: invitation.firstName,
        lastName: invitation.lastName,
        tenantId,
        role: invitation.role as UserRole,
      });
    }

    const userId = (user as any)._id.toString();
    const accountRole = this.toAccountRole(invitation.role);

    await this.membershipsService.ensureAccountMember({
      tenantId,
      userId,
      role: accountRole,
      invitedBy: (invitation.invitedBy as any)?.toString(),
    });

    // Invited users only get the workspaces chosen in the invitation (owners/admins see all anyway)
    const workspaceIds = (invitation.workspaceIds || []).map((id: any) => id.toString());

    await Promise.all(
      workspaceIds.map((workspaceId) =>
        this.membershipsService.setWorkspaceAccess({
          tenantId,
          userId,
          workspaceId,
          role: accountRole,
          permissions: invitation.permissions || [],
        }),
      ),
    );

    await this.invitationsService.markAsAccepted(
      (invitation as any)._id.toString(),
      userId,
    );

    const payload = {
      email: user.email,
      sub: (user as any)._id,
      tenantId: user.tenantId,
      role: user.role,
    };

    const tokens = this.generateTokens(payload);

    return {
      ...tokens,
      user: {
        id: (user as any)._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        tenantId: user.tenantId,
      },
    };
  }

  async refreshTokens(userId: string, activeTenantId?: string, activeRole?: string, issuedAt?: number) {
    const user = await this.usersService.findOne(userId);
    
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    const changedAt = (user as any).passwordChangedAt as Date | undefined;
    if (changedAt && issuedAt && issuedAt * 1000 < changedAt.getTime() - 1000) {
      throw new UnauthorizedException('Session expired');
    }

    const payload = {
      email: user.email,
      sub: (user as any)._id,
      tenantId: activeTenantId || user.tenantId,
      role: activeRole || user.role,
    };

    const accessTokenSecret = this.configService.get<string>('jwt.secret');

    return {
      access_token: this.jwtService.sign(payload, {
        secret: accessTokenSecret,
        expiresIn: '1h',
      } as any),
    };
  }

  async switchAccount(userId: string, tenantId: string) {
    const user = await this.usersService.findOne(userId);
    const membership = await this.membershipsService.findActiveAccountMember(tenantId, userId);

    const payload = {
      email: user.email,
      sub: (user as any)._id,
      tenantId,
      role: membership.role,
    };

    const tokens = this.generateTokens(payload);

    return {
      ...tokens,
      user: {
        id: (user as any)._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: membership.role,
        tenantId,
      },
    };
  }

  // ─── Password recovery ───

  /**
   * Always resolves the same way, so the endpoint cannot be used to discover which e-mails have an account.
   * The link is valid for one hour and works once.
   */
  async forgotPassword(email: string): Promise<void> {
    const clean = email.trim();
    const user = (await this.usersService.findByEmail(clean)) || (await this.usersService.findByEmail(clean.toLowerCase()));
    if (!user || !(user as any).isActive) return;

    const userId = (user as any)._id;
    // one live link per user, and no more than one new link per minute
    const last = await this.passwordResetModel.findOne({ userId }).sort({ createdAt: -1 }).lean();
    if (last && Date.now() - new Date((last as any).createdAt).getTime() < 60_000) return;
    await this.passwordResetModel.deleteMany({ userId });

    const token = randomBytes(32).toString('hex');
    await this.passwordResetModel.create({
      userId,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const base = (this.configService.get<string>('FRONTEND_URL') || this.configService.get<string>('CORS_ORIGIN') || 'http://localhost:3000').replace(/\/+$/, '');
    const link = `${base}/auth/reset-password?token=${token}`;
    const name = (user.firstName || '').replace(/[<>&]/g, '');
    const sent = await this.mailer.send(
      user.email,
      'Restablece tu contraseña de AXENTYC',
      `<div style="font-family:Arial,sans-serif;max-width:520px"><h2>Restablecer contraseña</h2><p>Hola ${name},</p><p>Recibimos una solicitud para restablecer la contraseña de tu cuenta de AXENTYC. El enlace es válido por 1 hora y solo funciona una vez.</p><p><a href="${link}" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Crear nueva contraseña</a></p><p style="color:#888;font-size:12px">Si no fuiste tú, ignora este correo: tu contraseña no cambiará.</p></div>`,
    );
    if (!sent) this.logger.error('Password reset e-mail could not be sent (is SYSTEM_SMTP_* configured?)');
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    // Atomic: the link can only be consumed once even with concurrent requests
    const record = await this.passwordResetModel.findOneAndDelete({ tokenHash, expiresAt: { $gt: new Date() } });
    if (!record) throw new BadRequestException('El enlace no es válido o ya venció. Solicita uno nuevo.');

    await this.usersService.changePassword(record.userId.toString(), newPassword);
    await this.passwordResetModel.deleteMany({ userId: record.userId });
  }
}
