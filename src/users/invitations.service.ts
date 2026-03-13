import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'crypto';
import { Invitation, InvitationDocument, InvitationStatus } from './entities/invitation.entity';
import { InviteUserDto } from './dto/invite-user.dto';

@Injectable()
export class InvitationsService {
  constructor(
    @InjectModel(Invitation.name)
    private invitationModel: Model<InvitationDocument>,
  ) {}

  async create(
    tenantId: string,
    invitedById: string,
    dto: InviteUserDto,
  ): Promise<Invitation> {
    // Check if user already exists or has pending invitation
    const existingInvite = await this.invitationModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      email: dto.email.toLowerCase(),
      status: InvitationStatus.PENDING,
    });

    if (existingInvite) {
      throw new BadRequestException('User already has a pending invitation');
    }

    const token = `inv_${randomBytes(32).toString('hex')}`;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

    const invitation = new this.invitationModel({
      tenantId: new Types.ObjectId(tenantId),
      email: dto.email.toLowerCase(),
      firstName: dto.firstName,
      lastName: dto.lastName,
      role: dto.role,
      token,
      invitedBy: new Types.ObjectId(invitedById),
      expiresAt,
      status: InvitationStatus.PENDING,
    });

    return invitation.save();
  }

  async findByToken(token: string): Promise<Invitation> {
    const invitation = await this.invitationModel
      .findOne({ token })
      .populate('tenantId', 'name slug')
      .exec();

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.status !== InvitationStatus.PENDING) {
      throw new BadRequestException('Invitation already used or cancelled');
    }

    if (invitation.expiresAt < new Date()) {
      invitation.status = InvitationStatus.EXPIRED;
      await invitation.save();
      throw new BadRequestException('Invitation has expired');
    }

    return invitation;
  }

  async findAllByTenant(tenantId: string): Promise<Invitation[]> {
    return this.invitationModel
      .find({ tenantId: new Types.ObjectId(tenantId) })
      .populate('invitedBy', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .exec();
  }

  async markAsAccepted(
    invitationId: string,
    acceptedUserId: string,
  ): Promise<Invitation> {
    const invitation = await this.invitationModel.findById(invitationId);
    
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    invitation.status = InvitationStatus.ACCEPTED;
    invitation.acceptedUserId = new Types.ObjectId(acceptedUserId);
    invitation.acceptedAt = new Date();

    return invitation.save();
  }

  async cancel(tenantId: string, invitationId: string): Promise<void> {
    const invitation = await this.invitationModel.findOne({
      _id: invitationId,
      tenantId: new Types.ObjectId(tenantId),
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    invitation.status = InvitationStatus.CANCELLED;
    await invitation.save();
  }

  async cleanupExpired(): Promise<number> {
    const result = await this.invitationModel.updateMany(
      {
        status: InvitationStatus.PENDING,
        expiresAt: { $lt: new Date() },
      },
      { status: InvitationStatus.EXPIRED },
    );

    return result.modifiedCount;
  }
}
