import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MembershipsService } from '../memberships/memberships.service';
import { RequiresFeature } from '../billing/billing.guards';
import { InvoicingService } from './invoicing.service';
import { AddPaymentDto, CreateSalesDocDto, FromDealDto, SendDocDto, SetStatusDto, UpdateSalesDocDto, UpsertProductDto } from './dto/invoicing.dto';

@ApiTags('invoicing')
@ApiBearerAuth()
@RequiresFeature('invoicing')
@Controller()
export class InvoicingController {
  constructor(
    private readonly service: InvoicingService,
    private readonly memberships: MembershipsService,
  ) {}

  private uid = (user: any): string => user._id || user.sub;
  private access = (user: any, workspaceId?: string) => this.memberships.assertCanAccessWorkspace(user.tenantId, this.uid(user), workspaceId);

  @Get('sales-documents')
  @ApiOperation({ summary: 'List quotes / invoices' })
  async list(
    @CurrentUser() user: any,
    @Query('workspaceId') workspaceId?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('contactId') contactId?: string,
    @Query('dealId') dealId?: string,
    @Query('q') q?: string,
  ) {
    await this.access(user, workspaceId);
    return this.service.list(user.tenantId, workspaceId, { type, status, contactId, dealId, q });
  }

  @Post('sales-documents')
  async create(@CurrentUser() user: any, @Body() dto: CreateSalesDocDto) {
    await this.access(user, dto.workspaceId);
    return this.service.create(user.tenantId, this.uid(user), dto);
  }

  @Post('sales-documents/from-deal/:dealId')
  @ApiOperation({ summary: 'Create a quote/invoice from a deal' })
  async fromDeal(@CurrentUser() user: any, @Param('dealId') dealId: string, @Body() dto: FromDealDto) {
    await this.access(user, dto.workspaceId);
    return this.service.fromDeal(user.tenantId, this.uid(user), dealId, dto.type, dto.workspaceId);
  }

  @Get('sales-documents/:id')
  async get(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.access(user, workspaceId);
    return this.service.get(user.tenantId, id, workspaceId);
  }

  @Get('sales-documents/:id/pdf')
  @ApiOperation({ summary: 'Download the PDF' })
  async pdf(@CurrentUser() user: any, @Param('id') id: string, @Res() res: Response, @Query('workspaceId') workspaceId?: string) {
    await this.access(user, workspaceId);
    const { buffer, filename } = await this.service.pdf(user.tenantId, id, workspaceId);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': String(buffer.length) });
    res.end(buffer);
  }

  @Put('sales-documents/:id')
  async update(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: UpdateSalesDocDto) {
    await this.access(user, dto.workspaceId);
    return this.service.update(user.tenantId, id, dto);
  }

  @Delete('sales-documents/:id')
  async remove(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.access(user, workspaceId);
    return this.service.remove(user.tenantId, id, workspaceId);
  }

  @Post('sales-documents/:id/status')
  async setStatus(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: SetStatusDto) {
    await this.access(user, dto.workspaceId);
    return this.service.setStatus(user.tenantId, id, dto);
  }

  @Post('sales-documents/:id/send')
  @ApiOperation({ summary: 'E-mail the PDF to the customer from a connected mailbox' })
  async send(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: SendDocDto) {
    await this.access(user, dto.workspaceId);
    return this.service.send(user.tenantId, id, dto);
  }

  @Post('sales-documents/:id/convert')
  @ApiOperation({ summary: 'Turn a quote into an invoice' })
  async convert(@CurrentUser() user: any, @Param('id') id: string, @Body('workspaceId') workspaceId?: string) {
    await this.access(user, workspaceId);
    return this.service.convertQuote(user.tenantId, this.uid(user), id, workspaceId);
  }

  @Post('sales-documents/:id/payments')
  @ApiOperation({ summary: 'Register a manual payment (cash, Zelle, transfer, check...)' })
  async addPayment(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: AddPaymentDto) {
    await this.access(user, dto.workspaceId);
    return this.service.addPayment(user.tenantId, this.uid(user), id, dto);
  }

  @Delete('sales-documents/:id/payments/:paymentId')
  async removePayment(@CurrentUser() user: any, @Param('id') id: string, @Param('paymentId') paymentId: string, @Query('workspaceId') workspaceId?: string) {
    await this.access(user, workspaceId);
    return this.service.removePayment(user.tenantId, id, paymentId, workspaceId);
  }

  // Products / services catalog
  @Get('products')
  async products(@CurrentUser() user: any, @Query('workspaceId') workspaceId?: string, @Query('all') all?: string) {
    await this.access(user, workspaceId);
    return this.service.listProducts(user.tenantId, workspaceId, all === 'true');
  }

  @Post('products')
  async createProduct(@CurrentUser() user: any, @Body() dto: UpsertProductDto) {
    await this.access(user, dto.workspaceId);
    return this.service.createProduct(user.tenantId, dto);
  }

  @Patch('products/:id')
  async updateProduct(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: UpsertProductDto) {
    await this.access(user, dto.workspaceId);
    return this.service.updateProduct(user.tenantId, id, dto);
  }

  @Delete('products/:id')
  async removeProduct(@CurrentUser() user: any, @Param('id') id: string, @Query('workspaceId') workspaceId?: string) {
    await this.access(user, workspaceId);
    return this.service.removeProduct(user.tenantId, id, workspaceId);
  }
}
