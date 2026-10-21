import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ChatWidgetService } from './chat-widget.service';
import { ChatWidgetController } from './chat-widget.controller';
import { WidgetConfig, WidgetConfigSchema } from './entities/widget-config.entity';
import { ConversationsModule } from '../conversations/conversations.module';
import { UsersModule } from '../users/users.module';
import { BillingModule } from '../billing/billing.module';
import { MembershipsModule } from '../memberships/memberships.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WidgetConfig.name, schema: WidgetConfigSchema },
    ]),
    ConversationsModule,
    UsersModule,
    BillingModule,
    MembershipsModule,
  ],
  controllers: [ChatWidgetController],
  providers: [ChatWidgetService],
  exports: [ChatWidgetService],
})
export class ChatWidgetModule {}
