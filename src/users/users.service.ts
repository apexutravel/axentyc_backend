import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private userModel: Model<UserDocument>,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<User> {
    const existingUser = await this.userModel.findOne({
      email: createUserDto.email,
    });

    if (existingUser) {
      throw new ConflictException('Email already exists');
    }

    const hashedPassword = await bcrypt.hash(createUserDto.password, 10);

    const user = new this.userModel({
      ...createUserDto,
      password: hashedPassword,
      tenantId: createUserDto.tenantId
        ? new Types.ObjectId(createUserDto.tenantId)
        : undefined,
    });

    return user.save();
  }

  async findAll(): Promise<User[]> {
    return this.userModel.find().exec();
  }

  async findOne(id: string): Promise<User> {
    const user = await this.userModel.findById(id).exec();
    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userModel.findOne({ email }).exec();
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    if (updateUserDto.password) {
      updateUserDto.password = await bcrypt.hash(updateUserDto.password, 10);
    }

    const user = await this.userModel
      .findByIdAndUpdate(id, updateUserDto, { returnDocument: 'after' })
      .exec();

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    return user;
  }

  async remove(id: string): Promise<void> {
    const result = await this.userModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
  }

  async findByTenant(tenantId: string): Promise<User[]> {
    return this.userModel
      .find({ tenantId: new Types.ObjectId(tenantId) })
      .select('-password')
      .sort({ createdAt: -1 })
      .exec();
  }

  async changePassword(userId: string, newPassword: string): Promise<User> {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    const user = await this.userModel
      .findByIdAndUpdate(
        userId,
        { password: hashedPassword },
        { returnDocument: 'after' },
      )
      .exec();

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    return user;
  }

  async changeRole(userId: string, tenantId: string, role: string): Promise<User> {
    const user = await this.userModel
      .findOneAndUpdate(
        { _id: userId, tenantId: new Types.ObjectId(tenantId) },
        { role },
        { returnDocument: 'after' },
      )
      .select('-password')
      .exec();

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found in this tenant`);
    }

    return user;
  }
}
