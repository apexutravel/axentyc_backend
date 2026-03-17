import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Conversation, ConversationSchema } from './entities/conversation.entity';
import { Message, MessageSchema } from './entities/message.entity';
import { Contact, ContactSchema } from '../crm/entities/contact.entity';
import { ConversationsService } from './conversations.service';
import { ConversationsController } from './conversations.controller';
import { FacebookModule } from '../facebook/facebook.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
      { name: Contact.name, schema: ContactSchema },
    ]),
    forwardRef(() => FacebookModule),
  ],
  controllers: [ConversationsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
