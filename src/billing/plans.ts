export type BillingCycle = 'monthly' | 'yearly';

export interface PlanLimits {
  maxUsers: number;
  maxWorkspaces: number;
  maxConnectedAssets: number;
  maxSocialAccounts: number;
  maxEmailIntegrations: number;
  maxWidgets: number;
  maxConversationsMonthly: number;
  automationsEnabled: boolean;
  teamRolesEnabled: boolean;
  whiteLabelEnabled: boolean;
}

export interface PlanDefinition {
  key: string;
  name: string;
  description: string;
  monthlyPrice: number;
  yearlyPrice: number;
  trialDays: number;
  limits: PlanLimits;
  features: string[];
  recommended?: boolean;
}

export const PLAN_DEFINITIONS: PlanDefinition[] = [
  {
    key: 'free',
    name: 'Free',
    description: 'Para probar AXENTYC con límites básicos.',
    monthlyPrice: 0,
    yearlyPrice: 0,
    trialDays: 0,
    limits: {
      maxUsers: 1,
      maxWorkspaces: 1,
      maxConnectedAssets: 1,
      maxSocialAccounts: 1,
      maxEmailIntegrations: 1,
      maxWidgets: 1,
      maxConversationsMonthly: 50,
      automationsEnabled: false,
      teamRolesEnabled: false,
      whiteLabelEnabled: false,
    },
    features: ['1 workspace', '1 usuario', '1 activo conectado', '50 conversaciones/mes'],
  },
  {
    key: 'starter',
    name: 'Starter',
    description: 'Para negocios pequeños que empiezan a centralizar conversaciones.',
    monthlyPrice: 29,
    yearlyPrice: 23,
    trialDays: 14,
    limits: {
      maxUsers: 3,
      maxWorkspaces: 1,
      maxConnectedAssets: 3,
      maxSocialAccounts: 3,
      maxEmailIntegrations: 3,
      maxWidgets: 3,
      maxConversationsMonthly: 500,
      automationsEnabled: false,
      teamRolesEnabled: true,
      whiteLabelEnabled: false,
    },
    features: ['1 workspace', '3 usuarios', '3 activos conectados', '500 conversaciones/mes'],
  },
  {
    key: 'pro',
    name: 'Pro',
    description: 'Para equipos que necesitan CRM, automatizaciones y varios canales.',
    monthlyPrice: 79,
    yearlyPrice: 63,
    trialDays: 14,
    recommended: true,
    limits: {
      maxUsers: 10,
      maxWorkspaces: 5,
      maxConnectedAssets: 15,
      maxSocialAccounts: 15,
      maxEmailIntegrations: 15,
      maxWidgets: 15,
      maxConversationsMonthly: 5000,
      automationsEnabled: true,
      teamRolesEnabled: true,
      whiteLabelEnabled: false,
    },
    features: ['5 workspaces', '10 usuarios', '15 activos conectados', 'Automatizaciones', 'CRM completo', 'Reportes'],
  },
  {
    key: 'business',
    name: 'Business',
    description: 'Para equipos, agencias y operaciones multi-marca.',
    monthlyPrice: 199,
    yearlyPrice: 159,
    trialDays: 14,
    limits: {
      maxUsers: 30,
      maxWorkspaces: 25,
      maxConnectedAssets: 75,
      maxSocialAccounts: 75,
      maxEmailIntegrations: 75,
      maxWidgets: 75,
      maxConversationsMonthly: 25000,
      automationsEnabled: true,
      teamRolesEnabled: true,
      whiteLabelEnabled: true,
    },
    features: ['25 workspaces', '30 usuarios', '75 activos conectados', 'White-label', 'Soporte prioritario'],
  },
];

export function getPlanDefinition(planKey?: string): PlanDefinition {
  const normalizedPlanKey = planKey === 'professional'
    ? 'pro'
    : planKey === 'agency' || planKey === 'enterprise'
      ? 'business'
      : planKey;

  return PLAN_DEFINITIONS.find((plan) => plan.key === normalizedPlanKey) || PLAN_DEFINITIONS[1];
}
