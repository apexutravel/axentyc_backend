import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type InvitationDocument = Invitation & Document;

export enum InvitationStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

@Schema({ timestamps: true })
export class Invitation {
  @Prop({ type: Types.ObjectId, ref: 'Tenant', required: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true, lowercase: true })
  email: string;

  @Prop({ required: true })
  firstName: string;

  @Prop({ required: true })
  lastName: string;

  @Prop({ required: true })
  role: string;

  @Prop({ required: true, unique: true })
  token: string;

  @Prop({ type: String, enum: InvitationStatus, default: InvitationStatus.PENDING })
  status: InvitationStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  invitedBy: Types.ObjectId;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  acceptedUserId?: Types.ObjectId;

  @Prop()
  acceptedAt?: Date;
}

export const InvitationSchema = SchemaFactory.createForClass(Invitation);

InvitationSchema.index({ tenantId: 1, email: 1 });
InvitationSchema.index({ token: 1 });
InvitationSchema.index({ expiresAt: 1 });
