import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Automation, AutomationSchema } from './entities/automation.entity';
import { AutomationsService } from './automations.service';
import { AutomationsController } from './automations.controller';
import { MembershipsModule } from '../memberships/memberships.module';

@Module({
  imports: [
    MembershipsModule,
    MongooseModule.forFeature([
      { name: Automation.name, schema: AutomationSchema },
    ]),
  ],
  controllers: [AutomationsController],
  providers: [AutomationsService],
  exports: [AutomationsService],
})
export class AutomationsModule {}
