import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';
import { Task, TaskSchema } from './entities/task.entity';
import { Note, NoteSchema } from './entities/note.entity';
import { QuickReply, QuickReplySchema } from './entities/quick-reply.entity';
import { Contact, ContactSchema } from '../crm/entities/contact.entity';
import { Lead, LeadSchema } from '../crm/entities/lead.entity';
import { Deal, DealSchema } from '../crm/entities/deal.entity';
import { Conversation, ConversationSchema } from '../conversations/entities/conversation.entity';
import { SalesDocument, SalesDocumentSchema } from '../invoicing/entities/sales-document.entity';
import { MembershipsModule } from '../memberships/memberships.module';

@Module({
  imports: [
    MembershipsModule,
    MongooseModule.forFeature([
      { name: Task.name, schema: TaskSchema },
      { name: Note.name, schema: NoteSchema },
      { name: QuickReply.name, schema: QuickReplySchema },
      { name: Contact.name, schema: ContactSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: Deal.name, schema: DealSchema },
      { name: Conversation.name, schema: ConversationSchema },
      { name: SalesDocument.name, schema: SalesDocumentSchema },
    ]),
  ],
  controllers: [ActivitiesController],
  providers: [ActivitiesService],
  exports: [ActivitiesService, MongooseModule],
})
export class ActivitiesModule {}
