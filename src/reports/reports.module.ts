import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { BillingModule } from '../billing/billing.module';
import { Task, TaskSchema } from '../activities/entities/task.entity';
import { MembershipsModule } from '../memberships/memberships.module';
import { Conversation, ConversationSchema } from '../conversations/entities/conversation.entity';
import { Message, MessageSchema } from '../conversations/entities/message.entity';
import { Contact, ContactSchema } from '../crm/entities/contact.entity';
import { Lead, LeadSchema } from '../crm/entities/lead.entity';
import { Deal, DealSchema } from '../crm/entities/deal.entity';
import { SalesDocument, SalesDocumentSchema } from '../invoicing/entities/sales-document.entity';
import { User, UserSchema } from '../users/entities/user.entity';

@Module({
  imports: [
    MembershipsModule,
    BillingModule,
    MongooseModule.forFeature([
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
      { name: Contact.name, schema: ContactSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: Deal.name, schema: DealSchema },
      { name: SalesDocument.name, schema: SalesDocumentSchema },
      { name: User.name, schema: UserSchema },
      { name: Task.name, schema: TaskSchema },
    ]),
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
