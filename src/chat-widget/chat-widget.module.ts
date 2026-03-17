import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ChatWidgetService } from './chat-widget.service';
import { ChatWidgetController } from './chat-widget.controller';
import { WidgetConfig, WidgetConfigSchema } from './entities/widget-config.entity';
import { ConversationsModule } from '../conversations/conversations.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WidgetConfig.name, schema: WidgetConfigSchema },
    ]),
    ConversationsModule,
    UsersModule,
  ],
  controllers: [ChatWidgetController],
  providers: [ChatWidgetService],
  exports: [ChatWidgetService],
})
export class ChatWidgetModule {}
