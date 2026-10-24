/**
 * Single source of truth for plans.
 *
 * Everything a customer is promised on /pricing is generated from these definitions, and every
 * limit/feature listed here is enforced by the backend (see BillingService). If something is not
 * enforced it does not belong here, and if it is not built it must not be advertised.
 *
 * Numeric limits use -1 for "unlimited".
 */
export type BillingCycle = 'monthly' | 'yearly';

export const UNLIMITED = -1;

export interface PlanLimits {
  /** Team members (active users + pending invitations) */
  maxUsers: number;
  /** Companies / brands / clients inside the account */
  maxWorkspaces: number;
  /** Connected channels: Facebook page, Instagram account, email mailbox or web widget */
  maxConnectedAssets: number;
  /** Automation rules */
  maxAutomations: number;
  /** New conversations per month. Past the cap, inbound messages are still received but replies are blocked */
  maxConversationsMonthly: number;
}

export interface PlanFeatures {
  /** Quotes, invoices, manual payments, PDF + e-mail and the products catalog */
  invoicing: boolean;
  /** Sales pipeline (deals) and lead -> deal conversion */
  deals: boolean;
  /** Roles other than "agent" (manager, admin, viewer) and per-workspace access control */
  teamRoles: boolean;
  /** Remove the "Powered by AXENTYC" badge from the chat widget */
  removeBranding: boolean;
  /** Priority support (informational) */
  prioritySupport: boolean;
}

export type PlanFeatureKey = keyof PlanFeatures;
export type PlanLimitKey = keyof PlanLimits;

export interface PlanDefinition {
  key: string;
  name: string;
  tagline: string;
  description: string;
  /** Price per month when billed monthly */
  monthlyPrice: number;
  /** Price per month when billed yearly (the customer is charged yearlyPrice * 12 once a year) */
  yearlyPrice: number;
  /** Free trial days for paid plans (no card required) */
  trialDays: number;
  limits: PlanLimits;
  features: PlanFeatures;
  /** Human readable bullets, generated from limits/features so the page can never drift */
  highlights: string[];
  recommended?: boolean;
}

type PlanSpec = Omit<PlanDefinition, 'highlights'>;

const PLAN_SPECS: PlanSpec[] = [
  {
    key: 'free',
    name: 'Free',
    tagline: 'Explora',
    description: 'Para conocer AXENTYC con un canal y sin tarjeta. Sin vencimiento.',
    monthlyPrice: 0,
    yearlyPrice: 0,
    trialDays: 0,
    limits: {
      maxUsers: 1,
      maxWorkspaces: 1,
      maxConnectedAssets: 1,
      maxAutomations: 0,
      maxConversationsMonthly: 50,
    },
    features: { invoicing: false, deals: false, teamRoles: false, removeBranding: false, prioritySupport: false },
  },
  {
    key: 'starter',
    name: 'Starter',
    tagline: 'Para empezar',
    description: 'Para un negocio pequeño que centraliza sus conversaciones y contactos.',
    monthlyPrice: 29,
    yearlyPrice: 23,
    trialDays: 14,
    limits: {
      maxUsers: 3,
      maxWorkspaces: 1,
      maxConnectedAssets: 3,
      maxAutomations: 3,
      maxConversationsMonthly: 500,
    },
    features: { invoicing: true, deals: false, teamRoles: false, removeBranding: false, prioritySupport: false },
  },
  {
    key: 'pro',
    name: 'Pro',
    tagline: 'Más vendido',
    description: 'Para equipos que venden: pipeline de deals, roles y varias empresas.',
    monthlyPrice: 79,
    yearlyPrice: 63,
    trialDays: 14,
    recommended: true,
    limits: {
      maxUsers: 10,
      maxWorkspaces: 5,
      maxConnectedAssets: 15,
      maxAutomations: 25,
      maxConversationsMonthly: 5000,
    },
    features: { invoicing: true, deals: true, teamRoles: true, removeBranding: true, prioritySupport: false },
  },
  {
    key: 'agency',
    name: 'Agency',
    tagline: 'Multi-cliente',
    description: 'Para agencias y operaciones multi-marca que gestionan muchas empresas.',
    monthlyPrice: 199,
    yearlyPrice: 159,
    trialDays: 14,
    limits: {
      maxUsers: 30,
      maxWorkspaces: 25,
      maxConnectedAssets: 75,
      maxAutomations: UNLIMITED,
      maxConversationsMonthly: 25000,
    },
    features: { invoicing: true, deals: true, teamRoles: true, removeBranding: true, prioritySupport: true },
  },
];

const n = (value: number) => value.toLocaleString('en-US');
const plural = (value: number, one: string, many: string) => `${n(value)} ${value === 1 ? one : many}`;

export function buildHighlights(spec: PlanSpec): string[] {
  const { limits: l, features: f } = spec;
  const lines: string[] = [];

  if (spec.trialDays > 0) lines.push(`${spec.trialDays} días de prueba gratis, sin tarjeta`);
  lines.push(plural(l.maxWorkspaces, 'empresa (workspace)', 'empresas (workspaces)'));
  lines.push(plural(l.maxUsers, 'usuario', 'usuarios'));
  lines.push(plural(l.maxConnectedAssets, 'canal conectado', 'canales conectados'));
  lines.push(`${n(l.maxConversationsMonthly)} conversaciones nuevas/mes`);
  lines.push('Contact Center: Messenger, Instagram, email y widget web');
  lines.push('CRM: contactos, leads, tareas, notas y reportes');
  if (f.invoicing) lines.push('Cotizaciones y facturas con PDF y envío por email');
  if (l.maxAutomations === UNLIMITED) lines.push('Automatizaciones ilimitadas');
  else if (l.maxAutomations > 0) lines.push(plural(l.maxAutomations, 'automatización', 'automatizaciones'));
  if (f.deals) lines.push('Pipeline de deals');
  if (f.teamRoles) lines.push('Roles de equipo y acceso por empresa');
  if (f.removeBranding) lines.push('Widget sin marca AXENTYC');
  if (f.prioritySupport) lines.push('Soporte prioritario');
  return lines;
}

export const PLAN_DEFINITIONS: PlanDefinition[] = PLAN_SPECS.map((spec) => ({
  ...spec,
  highlights: buildHighlights(spec),
}));

/** Legacy keys that may still be stored on tenants. */
const PLAN_ALIASES: Record<string, string> = {
  professional: 'pro',
  business: 'agency',
  enterprise: 'agency',
};

export const DEFAULT_PLAN_KEY = 'starter';

export function normalizePlanKey(planKey?: string): string {
  return PLAN_ALIASES[planKey || ''] || planKey || DEFAULT_PLAN_KEY;
}

export function getPlanDefinition(planKey?: string): PlanDefinition {
  const key = normalizePlanKey(planKey);
  return PLAN_DEFINITIONS.find((plan) => plan.key === key) || PLAN_DEFINITIONS.find((p) => p.key === DEFAULT_PLAN_KEY)!;
}

export function isKnownPlan(planKey?: string): boolean {
  const key = normalizePlanKey(planKey);
  return PLAN_DEFINITIONS.some((plan) => plan.key === key);
}

export function isUnlimited(value: number): boolean {
  return value === UNLIMITED;
}

/** Price per month for a cycle. */
export function cyclePrice(plan: PlanDefinition, cycle: BillingCycle): number {
  return cycle === 'yearly' ? plan.yearlyPrice : plan.monthlyPrice;
}

/** What the customer is actually charged per billing period, in cents. */
export function periodAmountCents(plan: PlanDefinition, cycle: BillingCycle): number {
  const perMonth = cyclePrice(plan, cycle);
  return Math.round(perMonth * (cycle === 'yearly' ? 12 : 1) * 100);
}
