import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingPaymentsService } from './billing-payments.service';
import { BillingNoticesService } from './billing-notices.service';
import { SystemMailerService } from './system-mailer.service';
import { StripeClient } from './stripe.client';
import { MembershipsModule } from '../memberships/memberships.module';
import { Tenant, TenantSchema } from '../tenants/entities/tenant.entity';
import { User, UserSchema } from '../users/entities/user.entity';
import { Invitation, InvitationSchema } from '../users/entities/invitation.entity';
import { Workspace, WorkspaceSchema } from '../workspaces/entities/workspace.entity';
import { SocialAccount, SocialAccountSchema } from '../integrations/entities/social-account.entity';
import { EmailIntegration, EmailIntegrationSchema } from '../integrations/entities/email-integration.entity';
import { WidgetConfig, WidgetConfigSchema } from '../chat-widget/entities/widget-config.entity';
import { Automation, AutomationSchema } from '../automations/entities/automation.entity';
import { Conversation, ConversationSchema } from '../conversations/entities/conversation.entity';

@Module({
  imports: [
    forwardRef(() => MembershipsModule),
    MongooseModule.forFeature([
      { name: Tenant.name, schema: TenantSchema },
      { name: User.name, schema: UserSchema },
      { name: Invitation.name, schema: InvitationSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
      { name: SocialAccount.name, schema: SocialAccountSchema },
      { name: EmailIntegration.name, schema: EmailIntegrationSchema },
      { name: WidgetConfig.name, schema: WidgetConfigSchema },
      { name: Automation.name, schema: AutomationSchema },
      { name: Conversation.name, schema: ConversationSchema },
    ]),
  ],
  controllers: [BillingController],
  providers: [BillingService, BillingPaymentsService, BillingNoticesService, SystemMailerService, StripeClient],
  exports: [BillingService, SystemMailerService],
})
export class BillingModule {}
