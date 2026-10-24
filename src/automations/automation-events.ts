import { AutomationTrigger } from './entities/automation.entity';

/** Internal event name every module emits to run automations (decoupled: emitters never import the engine). */
export const AUTOMATION_EVENT = 'automation.trigger';

/** Max chained automation runs (an automation creating a lead that triggers another...). */
export const MAX_AUTOMATION_DEPTH = 2;

export interface AutomationEventPayload {
  trigger: AutomationTrigger;
  tenantId: string;
  workspaceId?: string;
  /** How many automation hops produced this event (0 = organic) */
  depth?: number;
  conversationId?: string;
  contactId?: string;
  leadId?: string;
  dealId?: string;
  invoiceId?: string;
  channel?: string;
  /** message text, for keyword conditions and {{message}} */
  text?: string;
  stage?: string;
  status?: string;
}
