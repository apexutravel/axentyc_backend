import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ContactsService } from '../services/contacts.service';
import { CreateContactDto } from '../dto/create-contact.dto';
import { UpdateContactDto } from '../dto/update-contact.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('contacts')
@ApiBearerAuth()
@Controller('contacts')
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new contact' })
  create(@CurrentUser() user: any, @Body() createContactDto: CreateContactDto) {
    return this.contactsService.create(user.tenantId, createContactDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all contacts for tenant' })
  findAll(@CurrentUser() user: any) {
    return this.contactsService.findAll(user.tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a contact by ID' })
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.contactsService.findOne(user.tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a contact' })
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() updateContactDto: UpdateContactDto,
  ) {
    return this.contactsService.update(user.tenantId, id, updateContactDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a contact' })
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.contactsService.remove(user.tenantId, id);
  }

  @Post('bulk-delete')
  @ApiOperation({ summary: 'Delete multiple contacts' })
  bulkDelete(@CurrentUser() user: any, @Body() body: { ids: string[] }) {
    return this.contactsService.bulkDelete(user.tenantId, body.ids);
  }
}
