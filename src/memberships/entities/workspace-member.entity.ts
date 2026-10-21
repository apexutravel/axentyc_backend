import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { AccountRole, MembershipStatus } from './account-member.entity';

export type WorkspaceMemberDocument = WorkspaceMember & Document;

@Schema({ timestamps: true })
export class WorkspaceMember {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: String, enum: AccountRole, required: true })
  role: AccountRole;

  @Prop({ type: [String], default: [] })
  permissions: string[];

  @Prop({ type: String, enum: MembershipStatus, default: MembershipStatus.ACTIVE })
  status: MembershipStatus;
}

export const WorkspaceMemberSchema = SchemaFactory.createForClass(WorkspaceMember);

WorkspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
WorkspaceMemberSchema.index({ tenantId: 1, userId: 1 });
