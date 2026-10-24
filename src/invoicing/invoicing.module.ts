import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { InvoicingController } from './invoicing.controller';
import { InvoicingService } from './invoicing.service';
import { DocCounter, DocCounterSchema, Product, ProductSchema, SalesDocument, SalesDocumentSchema } from './entities/sales-document.entity';
import { Contact, ContactSchema } from '../crm/entities/contact.entity';
import { Deal, DealSchema } from '../crm/entities/deal.entity';
import { Workspace, WorkspaceSchema } from '../workspaces/entities/workspace.entity';
import { EmailsModule } from '../emails/emails.module';
import { MembershipsModule } from '../memberships/memberships.module';

@Module({
  imports: [
    MembershipsModule,
    EmailsModule,
    MongooseModule.forFeature([
      { name: SalesDocument.name, schema: SalesDocumentSchema },
      { name: DocCounter.name, schema: DocCounterSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Contact.name, schema: ContactSchema },
      { name: Deal.name, schema: DealSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
    ]),
  ],
  controllers: [InvoicingController],
  providers: [InvoicingService],
  exports: [InvoicingService, MongooseModule],
})
export class InvoicingModule {}
