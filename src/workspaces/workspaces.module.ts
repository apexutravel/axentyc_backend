import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Workspace, WorkspaceSchema } from './entities/workspace.entity';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { Contact, ContactSchema } from '../crm/entities/contact.entity';
import { Lead, LeadSchema } from '../crm/entities/lead.entity';
import { Deal, DealSchema } from '../crm/entities/deal.entity';
import { Conversation, ConversationSchema } from '../conversations/entities/conversation.entity';
import { Message, MessageSchema } from '../conversations/entities/message.entity';
import { SocialAccount, SocialAccountSchema } from '../integrations/entities/social-account.entity';
import { EmailIntegration, EmailIntegrationSchema } from '../integrations/entities/email-integration.entity';
import { WidgetConfig, WidgetConfigSchema } from '../chat-widget/entities/widget-config.entity';
import { EmailMessage, EmailMessageSchema } from '../emails/entities/email-message.entity';
import { Automation, AutomationSchema } from '../automations/entities/automation.entity';
import { BillingModule } from '../billing/billing.module';
import { MembershipsModule } from '../memberships/memberships.module';

@Module({
  imports: [
    BillingModule,
    MembershipsModule,
    MongooseModule.forFeature([
      { name: Workspace.name, schema: WorkspaceSchema },
      { name: Contact.name, schema: ContactSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: Deal.name, schema: DealSchema },
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
      { name: SocialAccount.name, schema: SocialAccountSchema },
      { name: EmailIntegration.name, schema: EmailIntegrationSchema },
      { name: WidgetConfig.name, schema: WidgetConfigSchema },
      { name: EmailMessage.name, schema: EmailMessageSchema },
      { name: Automation.name, schema: AutomationSchema },
    ]),
  ],
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
