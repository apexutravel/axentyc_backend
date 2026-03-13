import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Contact, ContactSchema } from './entities/contact.entity';
import { Lead, LeadSchema } from './entities/lead.entity';
import { Deal, DealSchema } from './entities/deal.entity';
import { ContactsService } from './services/contacts.service';
import { LeadsService } from './services/leads.service';
import { DealsService } from './services/deals.service';
import { ContactsController } from './controllers/contacts.controller';
import { LeadsController } from './controllers/leads.controller';
import { DealsController } from './controllers/deals.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Contact.name, schema: ContactSchema },
      { name: Lead.name, schema: LeadSchema },
      { name: Deal.name, schema: DealSchema },
    ]),
  ],
  controllers: [ContactsController, LeadsController, DealsController],
  providers: [ContactsService, LeadsService, DealsService],
  exports: [ContactsService, LeadsService, DealsService],
})
export class CrmModule {}
