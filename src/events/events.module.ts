import { Module, Global } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { EventsGateway } from './events.gateway';
import { Conversation, ConversationSchema } from '../conversations/entities/conversation.entity';

@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot(),
    JwtModule.register({}),
    MongooseModule.forFeature([{ name: Conversation.name, schema: ConversationSchema }]),
  ],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}
