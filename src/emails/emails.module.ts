import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EmailsController } from './emails.controller';
import { EmailsService } from './emails.service';
import { EmailMessage, EmailMessageSchema } from './entities/email-message.entity';
import { IntegrationsModule } from '../integrations/integrations.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EmailMessage.name, schema: EmailMessageSchema },
    ]),
    forwardRef(() => IntegrationsModule),
    EventsModule,
  ],
  controllers: [EmailsController],
  providers: [EmailsService],
  exports: [EmailsService],
})
export class EmailsModule {}
