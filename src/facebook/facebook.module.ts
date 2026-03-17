import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FacebookService } from './facebook.service';
import { FacebookController } from './facebook.controller';
import { SocialAccount, SocialAccountSchema } from '../integrations/entities/social-account.entity';
import { Contact, ContactSchema } from '../crm/entities/contact.entity';
import { Conversation, ConversationSchema } from '../conversations/entities/conversation.entity';
import { Message, MessageSchema } from '../conversations/entities/message.entity';
import { FacebookConfig, FacebookConfigSchema } from './entities/facebook-config.entity';
import { ConversationsModule } from '../conversations/conversations.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SocialAccount.name, schema: SocialAccountSchema },
      { name: Contact.name, schema: ContactSchema },
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
      { name: FacebookConfig.name, schema: FacebookConfigSchema },
    ]),
    forwardRef(() => ConversationsModule),
    forwardRef(() => EventsModule),
  ],
  controllers: [FacebookController],
  providers: [FacebookService],
  exports: [FacebookService],
})
export class FacebookModule {}
