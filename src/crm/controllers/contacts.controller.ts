import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ContactsService } from '../services/contacts.service';
import { CreateContactDto } from '../dto/create-contact.dto';
import { UpdateContactDto } from '../dto/update-contact.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MembershipsService } from '../../memberships/memberships.service';

@ApiTags('contacts')
@ApiBearerAuth()
@Controller('contacts')
export class ContactsController {
  constructor(
    private readonly contactsService: ContactsService,
    private readonly membershipsService: MembershipsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new contact' })
  async create(@CurrentUser() user: any, @Body() createContactDto: CreateContactDto) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, createContactDto.workspaceId);
    return this.contactsService.create(user.tenantId, createContactDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all contacts for tenant' })
  @ApiQuery({ name: 'workspaceId', required: false })
  async findAll(@CurrentUser() user: any, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.contactsService.findAll(user.tenantId, workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a contact by ID' })
  async findOne(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.contactsService.findOne(user.tenantId, id, workspaceId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a contact' })
  async update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() updateContactDto: UpdateContactDto,
    @Query('workspaceId') workspaceId?: string,
  ) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.contactsService.update(user.tenantId, id, updateContactDto, workspaceId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a contact' })
  async remove(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, workspaceId);
    return this.contactsService.remove(user.tenantId, id, workspaceId);
  }

  @Post('bulk-delete')
  @ApiOperation({ summary: 'Delete multiple contacts' })
  async bulkDelete(
    @CurrentUser() user: any,
    @Body() body: { ids: string[]; workspaceId?: string },
  ) {
    await this.membershipsService.assertCanAccessWorkspace(user.tenantId, user._id || user.sub, body.workspaceId);
    return this.contactsService.bulkDelete(user.tenantId, body.ids, body.workspaceId);
  }
}
