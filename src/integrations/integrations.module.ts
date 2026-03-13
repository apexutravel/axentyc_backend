import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SocialAccount, SocialAccountSchema } from './entities/social-account.entity';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SocialAccount.name, schema: SocialAccountSchema },
    ]),
  ],
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
