import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { Tenant, TenantSchema } from '../tenants/entities/tenant.entity';
import { User, UserSchema } from '../users/entities/user.entity';
import { Workspace, WorkspaceSchema } from '../workspaces/entities/workspace.entity';
import { SocialAccount, SocialAccountSchema } from '../integrations/entities/social-account.entity';
import { EmailIntegration, EmailIntegrationSchema } from '../integrations/entities/email-integration.entity';
import { WidgetConfig, WidgetConfigSchema } from '../chat-widget/entities/widget-config.entity';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Tenant.name, schema: TenantSchema },
      { name: User.name, schema: UserSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
      { name: SocialAccount.name, schema: SocialAccountSchema },
      { name: EmailIntegration.name, schema: EmailIntegrationSchema },
      { name: WidgetConfig.name, schema: WidgetConfigSchema },
    ]),
  ],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
