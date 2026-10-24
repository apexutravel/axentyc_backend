import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Automation, AutomationSchema } from './entities/automation.entity';
import { AutomationRun, AutomationRunSchema } from './entities/automation-run.entity';
import { AutomationsService } from './automations.service';
import { AutomationEngineService } from './automation-engine.service';
import { AutomationsController } from './automations.controller';
import { BillingModule } from '../billing/billing.module';
import { MembershipsModule } from '../memberships/memberships.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { ActivitiesModule } from '../activities/activities.module';
import { Conversation, ConversationSchema } from '../conversations/entities/conversation.entity';
import { Contact, ContactSchema } from '../crm/entities/contact.entity';
import { Lead, LeadSchema } from '../crm/entities/lead.entity';
import { Deal, DealSchema } from '../crm/entities/deal.entity';
import { User, UserSchema } from '../users/entities/user.entity';

@Module({
  imports: [
    MembershipsModule,
    BillingModule,
    ConversationsModule,
    ActivitiesModule,
    MongooseModule.forFeature([
      { name: Automation.name, schema: AutomationSchema },
      { name: AutomationRun.name, schema: AutomationRunSchema },
      { name: Conversation.name, schema: ConversationSchema },
      { name: Contact.name, schema: ContactSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: Deal.name, schema: DealSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [AutomationsController],
  providers: [AutomationsService, AutomationEngineService],
  exports: [AutomationsService],
})
export class AutomationsModule {}
