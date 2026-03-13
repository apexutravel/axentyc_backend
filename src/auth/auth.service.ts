import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { TenantsService } from '../tenants/tenants.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { UserRole } from '../users/entities/user.entity';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private tenantsService: TenantsService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async register(registerDto: RegisterDto) {
    const slug =
      registerDto.companySlug ||
      registerDto.companyName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    const tenant = await this.tenantsService.create({
      name: registerDto.companyName,
      slug,
    });

    const user = await this.usersService.create({
      email: registerDto.email,
      password: registerDto.password,
      firstName: registerDto.firstName,
      lastName: registerDto.lastName,
      tenantId: (tenant as any)._id.toString(),
      role: UserRole.ADMIN,
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
        expiresIn: '15m',
      } as any),
      refresh_token: this.jwtService.sign(payload, {
        secret: refreshTokenSecret,
        expiresIn: '7d',
      } as any),
    };
  }

  async refreshTokens(userId: string) {
    const user = await this.usersService.findOne(userId);
    
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const payload = {
      email: user.email,
      sub: (user as any)._id,
      tenantId: user.tenantId,
      role: user.role,
    };

    const accessTokenSecret = this.configService.get<string>('jwt.secret');

    return {
      access_token: this.jwtService.sign(payload, {
        secret: accessTokenSecret,
        expiresIn: '15m',
      } as any),
    };
  }
}
