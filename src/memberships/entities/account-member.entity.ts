import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AccountMemberDocument = AccountMember & Document;

export enum AccountRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  MANAGER = 'manager',
  AGENT = 'agent',
  VIEWER = 'viewer',
}

export enum MembershipStatus {
  ACTIVE = 'active',
  INVITED = 'invited',
  SUSPENDED = 'suspended',
}

@Schema({ timestamps: true })
export class AccountMember {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: String, enum: AccountRole, required: true })
  role: AccountRole;

  @Prop({ type: String, enum: MembershipStatus, default: MembershipStatus.ACTIVE })
  status: MembershipStatus;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  invitedBy?: Types.ObjectId;

  @Prop({ type: Date, default: Date.now })
  joinedAt: Date;
}

export const AccountMemberSchema = SchemaFactory.createForClass(AccountMember);

AccountMemberSchema.index({ tenantId: 1, userId: 1 }, { unique: true });
AccountMemberSchema.index({ userId: 1, status: 1 });
