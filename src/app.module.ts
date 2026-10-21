import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { TenantsModule } from './tenants/tenants.module';
import { CrmModule } from './crm/crm.module';
import { ConversationsModule } from './conversations/conversations.module';
import { AutomationsModule } from './automations/automations.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { EventsModule } from './events/events.module';
import { ChatWidgetModule } from './chat-widget/chat-widget.module';
import { FirebaseAdminModule } from './firebase/firebase-admin.module';
import { UploadModule } from './upload/upload.module';
import { EmailsModule } from './emails/emails.module';
import { FacebookModule } from './facebook/facebook.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { WorkspaceScopeGuard } from './workspaces/workspace-scope.guard';
import { MembershipsModule } from './memberships/memberships.module';
import { BillingModule } from './billing/billing.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import databaseConfig from './config/database.config';
import jwtConfig from './config/jwt.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, jwtConfig],
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('database.uri'),
      }),
      inject: [ConfigService],
    }),
    UsersModule,
    AuthModule,
    TenantsModule,
    CrmModule,
    ConversationsModule,
    AutomationsModule,
    IntegrationsModule,
    EventsModule,
    ChatWidgetModule,
    FirebaseAdminModule,
    UploadModule,
    EmailsModule,
    FacebookModule,
    WorkspacesModule,
    MembershipsModule,
    BillingModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      // Must stay after JwtAuthGuard: it relies on request.user
      provide: APP_GUARD,
      useClass: WorkspaceScopeGuard,
    },
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
  ],
})
export class AppModule {}
