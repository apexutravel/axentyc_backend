const { run } = require('./harness');

// The whole sales journey, exactly as a customer would do it.
run('SALES JOURNEY: product -> contact -> lead -> deal -> quote -> invoice -> payment -> reports', async ({ ok, call, db, O }) => {
  let r = await call('POST', '/products', { name: 'Diseño de logo', unitPriceCents: 25000, taxable: true });
  ok(r.status === 201, '1. create product/service', r.json);
  const product = r.data;
  r = await call('POST', '/products', { name: 'Hosting anual', unitPriceCents: 12000, taxable: false });
  ok(r.status === 201, '1b. second product (no tax)');
  const hosting = r.data;
  r = await call('GET', '/products');
  ok(r.data.length === 2, 'catalog lists both', r.data.length);

  r = await call('POST', '/contacts', { name: 'Rosa Medina', email: 'rosa@example.com', phone: '+13055550111' });
  const contact = r.data;
  r = await call('POST', '/leads', { title: 'Logo y web para restaurante', contactId: contact._id, estimatedValue: 370 });
  ok(r.status === 201, '2. create lead', r.json);
  const lead = r.data;

  r = await call('POST', `/leads/${lead._id}/convert`, {});
  ok(r.status === 201 && r.data.title === lead.title && r.data.value === 370, '3. lead -> deal', r.json);
  const deal = r.data;
  ok((await db.collection('leads').findOne({ _id: O(lead._id) })).status === 'converted', 'lead marked converted');
  r = await call('POST', `/leads/${lead._id}/convert`, {});
  ok(String(r.data._id) === String(deal._id), 'converting again returns the same deal (no duplicate)');
  r = await call('PATCH', `/deals/${deal._id}`, { stage: 'proposal', probability: 50 });
  ok(r.data.stage === 'proposal', '3b. move deal to proposal');

  r = await call('POST', '/sales-documents', {
    type: 'quote', contactId: contact._id, dealId: deal._id,
    lines: [
      { description: product.name, quantity: 1, unitPriceCents: product.unitPriceCents, productId: product._id },
      { description: hosting.name, quantity: 1, unitPriceCents: hosting.unitPriceCents, taxable: false, productId: hosting._id },
    ],
  });
  ok(r.status === 201 && r.data.totalCents === 25000 + 2063 + 12000, '4. quote from catalog items, tax only on the taxable one', r.data);
  const quote = r.data;
  r = await call('POST', `/sales-documents/${quote._id}/status`, { status: 'sent' });
  ok(r.data.status === 'sent', '4b. quote sent');
  r = await call('POST', `/sales-documents/${quote._id}/status`, { status: 'accepted' });
  ok(r.data.status === 'accepted', '4c. quote accepted');

  r = await call('POST', `/sales-documents/${quote._id}/convert`, {});
  ok(r.status === 201 && r.data.type === 'invoice' && r.data.totalCents === quote.totalCents, '5. quote -> invoice (same amounts)', r.json);
  const invoice = r.data;
  r = await call('POST', `/sales-documents/${invoice._id}/payments`, { amountCents: 20000, method: 'zelle', reference: 'ZL-1' });
  ok(r.data.status === 'partial', '6. first payment (deposit) -> partial');
  r = await call('POST', `/sales-documents/${invoice._id}/payments`, { amountCents: invoice.totalCents - 20000, method: 'cash' });
  ok(r.data.status === 'paid' && r.data.balanceCents === 0, '6b. final payment -> paid');
  ok((await db.collection('deals').findOne({ _id: O(deal._id) })).stage === 'closed_won', '7. paying the invoice closes the deal as won');

  r = await call('GET', `/activities/timeline?contactId=${contact._id}`);
  const types = new Set(r.data.map((i) => i.type));
  ok(['lead', 'deal', 'quote', 'invoice', 'payment'].every((t) => types.has(t)), '8. customer timeline shows the whole journey', [...types]);

  r = await call('GET', '/reports/overview');
  const s = r.data.sales[0];
  ok(s && s.collectedCents === invoice.totalCents && s.outstandingCents === 0, '9. report: collected = invoice total, nothing outstanding', s);
  ok(r.data.funnel.dealsWon[0] && r.data.funnel.dealsWon[0].count === 1, '9b. report: 1 deal won', r.data.funnel);
  r = await call('GET', '/reports/dashboard');
  ok(r.status === 200 && r.data.invoices.length === 0, '10. dashboard: nothing left to collect', r.data.invoices);
});
