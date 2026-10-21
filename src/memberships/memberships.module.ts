import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccountMember, AccountMemberSchema } from './entities/account-member.entity';
import { WorkspaceMember, WorkspaceMemberSchema } from './entities/workspace-member.entity';
import { User, UserSchema } from '../users/entities/user.entity';
import { Workspace, WorkspaceSchema } from '../workspaces/entities/workspace.entity';
import { MembershipsController } from './memberships.controller';
import { MembershipsService } from './memberships.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AccountMember.name, schema: AccountMemberSchema },
      { name: WorkspaceMember.name, schema: WorkspaceMemberSchema },
      { name: User.name, schema: UserSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
    ]),
  ],
  controllers: [MembershipsController],
  providers: [MembershipsService],
  exports: [MembershipsService],
})
export class MembershipsModule {}
