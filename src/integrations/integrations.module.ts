import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SocialAccount, SocialAccountSchema } from './entities/social-account.entity';
import { EmailIntegration, EmailIntegrationSchema } from './entities/email-integration.entity';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';
import { EmailIntegrationsService } from './email-integrations.service';
import { EmailsModule } from '../emails/emails.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SocialAccount.name, schema: SocialAccountSchema },
      { name: EmailIntegration.name, schema: EmailIntegrationSchema },
    ]),
    forwardRef(() => EmailsModule),
  ],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, EmailIntegrationsService],
  exports: [IntegrationsService, EmailIntegrationsService],
})
export class IntegrationsModule {}
