import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersService } from './users.service';
import { InvitationsService } from './invitations.service';
import { UsersController } from './users.controller';
import { User, UserSchema } from './entities/user.entity';
import { Invitation, InvitationSchema } from './entities/invitation.entity';
import { BillingModule } from '../billing/billing.module';
import { MembershipsModule } from '../memberships/memberships.module';

@Module({
  imports: [
    BillingModule,
    MembershipsModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Invitation.name, schema: InvitationSchema },
    ]),
  ],
  controllers: [UsersController],
  providers: [UsersService, InvitationsService],
  exports: [UsersService, InvitationsService],
})
export class UsersModule {}
