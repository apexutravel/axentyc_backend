import { Controller, Post, Body, Get, UseGuards, Res, Req, HttpCode, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Response, Request } from 'express';
import { AuthService } from './auth.service';
import { InvitationsService } from '../users/invitations.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AcceptInviteDto } from '../users/dto/accept-invite.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RefreshTokenGuard } from './guards/refresh-token.guard';
import { User } from '../users/entities/user.entity';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly invitationsService: InvitationsService,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  async register(
    @Body() registerDto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { access_token, refresh_token, user, tenant } = await this.authService.register(registerDto);
    
    this.setAuthCookies(res, access_token, refresh_token);
    
    return { user, tenant };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Login user' })
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { access_token, refresh_token, user } = await this.authService.login(loginDto);
    
    this.setAuthCookies(res, access_token, refresh_token);
    
    return { user };
  }

  @Post('refresh')
  @UseGuards(RefreshTokenGuard)
  @ApiOperation({ summary: 'Refresh access token' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { access_token } = await this.authService.refreshTokens(req.user?.['sub']);
    
    res.cookie('access_token', access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000,
    });
    
    return { success: true };
  }

  @Get('profile')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  getProfile(@CurrentUser() user: User) {
    return user;
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Logout user' })
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('access_token');
    res.clearCookie('refresh_token');
    return { success: true };
  }

  @Public()
  @Get('verify-invite/:token')
  @ApiOperation({ summary: 'Verify invitation token' })
  async verifyInvite(@Param('token') token: string) {
    const invitation = await this.invitationsService.findByToken(token);
    return {
      valid: true,
      email: invitation.email,
      firstName: invitation.firstName,
      lastName: invitation.lastName,
      companyName: (invitation.tenantId as any).name,
    };
  }

  @Public()
  @Post('accept-invite')
  @ApiOperation({ summary: 'Accept invitation and create user account' })
  async acceptInvite(
    @Body() acceptInviteDto: AcceptInviteDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { access_token, refresh_token, user } = await this.authService.acceptInvite(acceptInviteDto);
    
    this.setAuthCookies(res, access_token, refresh_token);
    
    return { user };
  }

  private setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
    const isProduction = process.env.NODE_ENV === 'production';

    res.cookie('access_token', accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000,
    });

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }
}
