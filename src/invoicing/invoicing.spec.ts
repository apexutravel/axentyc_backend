import { BadRequestException } from '@nestjs/common';
import { computeTotals } from './totals';
import { displayStatus } from './invoicing.service';
import { pdfSafe, buildPdf } from './pdf';

describe('computeTotals', () => {
  const line = (unitPriceCents: number, extra: any = {}) => ({ description: 'Item', quantity: 1, unitPriceCents, ...extra });

  it('adds tax on top of the taxable lines only', () => {
    const t = computeTotals({ lines: [line(10000), line(5000, { taxable: false })], taxRatePct: 8.25 });
    expect(t.subtotalCents).toBe(15000);
    expect(t.taxCents).toBe(825); // 8.25% of $100.00 only
    expect(t.totalCents).toBe(15825);
  });

  it('applies line and document discounts before tax', () => {
    const t = computeTotals({ lines: [line(20000, { discountPct: 10 })], discountPct: 10, taxRatePct: 10 });
    // 200 - 10% = 180; doc discount 10% = 18; taxable base = 162; tax = 16.20; total = 180 - 18 + 16.20
    expect(t.subtotalCents).toBe(18000);
    expect(t.discountCents).toBe(1800);
    expect(t.taxCents).toBe(1620);
    expect(t.totalCents).toBe(17820);
  });

  it('prices that already include tax do not add it again', () => {
    const t = computeTotals({ lines: [line(10800)], taxRatePct: 8, taxIncluded: true });
    expect(t.totalCents).toBe(10800);
    expect(t.taxCents).toBe(800);
  });

  it('rounds each step so the printed numbers always add up', () => {
    const t = computeTotals({ lines: [{ description: 'x', quantity: 3, unitPriceCents: 333 }, line(1)], taxRatePct: 7.5 });
    expect(t.totalCents).toBe(t.subtotalCents - t.discountCents + t.taxCents);
    expect(Number.isInteger(t.totalCents)).toBe(true);
  });

  it('fractional quantities work (hours)', () => {
    expect(computeTotals({ lines: [{ description: 'Consulting', quantity: 1.5, unitPriceCents: 10000 }] }).totalCents).toBe(15000);
  });

  it('rejects invalid input', () => {
    const bad = (input: any) => expect(() => computeTotals(input)).toThrow(BadRequestException);
    bad({ lines: [] });
    bad({ lines: [line(100, { quantity: 0 })] });
    bad({ lines: [line(100, { quantity: -2 })] });
    bad({ lines: [line(-5)] });
    bad({ lines: [line(10.5)] });
    bad({ lines: [{ description: ' ', quantity: 1, unitPriceCents: 1 }] });
    bad({ lines: [line(100)], taxRatePct: 150 });
    bad({ lines: [line(100)], discountPct: -1 });
    bad({ lines: [line(100, { discountPct: 101 })] });
    bad({ lines: [line(Number.MAX_SAFE_INTEGER)] });
    bad({ lines: Array(101).fill(line(1)) });
    bad({ lines: [line(100)], taxRatePct: NaN });
  });
});

describe('displayStatus', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  const doc = (o: any) => ({ type: 'invoice', status: 'sent', totalCents: 100, amountPaidCents: 0, ...o });
  it('overdue only after the due day has fully passed', () => {
    expect(displayStatus(doc({ dueDate: new Date('2026-10-22T00:00:00Z') }), now)).toBe('sent');
    expect(displayStatus(doc({ dueDate: new Date('2026-10-20T00:00:00Z') }), now)).toBe('overdue');
    expect(displayStatus(doc({ status: 'partial', dueDate: new Date('2026-10-01T00:00:00Z') }), now)).toBe('overdue');
  });
  it('paid, draft and void never become overdue; quotes expire', () => {
    for (const status of ['paid', 'draft', 'void']) expect(displayStatus(doc({ status, dueDate: new Date('2020-01-01') }), now)).toBe(status);
    expect(displayStatus(doc({ type: 'quote', dueDate: new Date('2026-09-01') }), now)).toBe('expired');
  });
});

describe('pdf', () => {
  it('strips characters the core fonts cannot print, keeps accents', () => {
    expect(pdfSafe('Señor García – “hola” 😀')).toBe('Señor García - "hola" ?');
  });

  it('renders a valid multi-page PDF in both languages', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({ description: `Servicio número ${i + 1} con descripción larga `.repeat(2), quantity: 2, unitPriceCents: 12345, taxable: true, amountCents: 24690 }));
    const base = { number: 'INV-0001', type: 'invoice', status: 'paid', currency: 'USD', issueDate: new Date(), dueDate: new Date(), lines, subtotalCents: 1481400, discountPct: 0, discountCents: 0, taxRatePct: 8.25, taxName: 'Sales tax', taxIncluded: false, taxCents: 122215, totalCents: 1603615, amountPaidCents: 1603615, notes: 'Gracias por su compra', terms: 'Net 15' };
    for (const language of ['es', 'en']) {
      const buf = await buildPdf({ doc: { ...base, language }, contact: { name: 'María Pérez', email: 'm@x.com' }, business: { name: 'Mi Negocio', footerNote: 'Gracias' } });
      expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(buf.length).toBeGreaterThan(2000);
      expect((buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length).toBeGreaterThan(1);
    }
  });
});

import { csvCell, toCsv, isEmail, normalizePhone } from '../crm/services/contacts-csv';
describe('contacts csv', () => {
  it('neutralises formula injection and quotes special characters', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1 305')).toBe("'+1 305");
    expect(csvCell('Pérez, Ana')).toBe('"Pérez, Ana"');
    expect(csvCell(undefined)).toBe('');
  });
  it('writes a BOM, header and one row per contact', () => {
    const csv = toCsv([{ name: 'Ana', email: 'a@x.com', tags: 'vip;nuevo' }]);
    expect(csv.startsWith('\uFEFFname,email')).toBe(true);
    expect(csv.split('\r\n')).toHaveLength(2);
  });
  it('validates email / phone helpers', () => {
    expect(isEmail('a@b.co')).toBe(true);
    expect(isEmail('a@b')).toBe(false);
    expect(normalizePhone('+1 (305) 555-0100')).toBe('13055550100');
  });
});
