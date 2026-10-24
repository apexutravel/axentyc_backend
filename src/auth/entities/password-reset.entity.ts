import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type PasswordResetDocument = PasswordReset & Document;

/** Only a SHA-256 of the token is stored: a database leak does not expose usable reset links. */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class PasswordReset {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true, unique: true })
  tokenHash: string;

  @Prop({ type: Date, required: true })
  expiresAt: Date;
}

export const PasswordResetSchema = SchemaFactory.createForClass(PasswordReset);
// MongoDB removes expired documents on its own
PasswordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
