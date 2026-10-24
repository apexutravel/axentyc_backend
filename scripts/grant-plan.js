#!/usr/bin/env node
/**
 * Grants a plan to an account WITHOUT payment (courtesy / internal / partner accounts).
 * The account never expires nor locks until you change it again.
 *
 *   node scripts/grant-plan.js "Apexucode" agency
 *   node scripts/grant-plan.js "Apexucode" free        (removes the courtesy)
 */
require('dotenv').config();
const mongoose = require('mongoose');

const PLANS = {
  free: { maxUsers: 1, maxWorkspaces: 1, maxConnectedAssets: 1, maxAutomations: 0, maxConversationsMonthly: 50 },
  starter: { maxUsers: 3, maxWorkspaces: 1, maxConnectedAssets: 3, maxAutomations: 3, maxConversationsMonthly: 500 },
  pro: { maxUsers: 10, maxWorkspaces: 5, maxConnectedAssets: 15, maxAutomations: 25, maxConversationsMonthly: 5000 },
  agency: { maxUsers: 30, maxWorkspaces: 25, maxConnectedAssets: 75, maxAutomations: -1, maxConversationsMonthly: 25000 },
};

(async () => {
  const [name, planKey] = process.argv.slice(2);
  if (!name || !PLANS[planKey]) {
    console.error('Usage: node scripts/grant-plan.js "<account name>" <free|starter|pro|agency>');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const tenants = mongoose.connection.db.collection('tenants');
  const tenant = await tenants.findOne({ name });
  if (!tenant) {
    console.error(`Account "${name}" not found`);
    process.exit(1);
  }
  const free = planKey === 'free';
  await tenants.updateOne(
    { _id: tenant._id },
    {
      $set: {
        plan: planKey,
        status: 'active',
        isActive: true,
        limits: PLANS[planKey],
        subscription: {
          planKey,
          status: 'active',
          billingCycle: 'monthly',
          provider: 'manual',
          cancelAtPeriodEnd: false,
          complimentary: !free,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 365 * 24 * 3600 * 1000),
        },
      },
      $unset: { trialEndsAt: '' },
    },
  );
  console.log(`"${name}" is now on ${planKey}${free ? '' : ' (courtesy, no payment)'}`);
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
