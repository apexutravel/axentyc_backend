import PDFDocument from 'pdfkit';

type Lang = 'es' | 'en';

const T: Record<Lang, Record<string, string>> = {
  es: {
    invoice: 'FACTURA', quote: 'COTIZACIÓN', number: 'Número', issue: 'Fecha', due: 'Vence', valid: 'Válida hasta',
    billTo: 'Facturar a', quoteFor: 'Cotización para', description: 'Descripción', qty: 'Cant.', price: 'Precio', amount: 'Importe',
    subtotal: 'Subtotal', discount: 'Descuento', tax: 'Impuesto', taxIncluded: 'incluido', total: 'Total', paid: 'Pagado', balance: 'Saldo',
    notes: 'Notas', terms: 'Términos', status: 'Estado', void: 'ANULADA', paidStamp: 'PAGADA', page: 'Página',
  },
  en: {
    invoice: 'INVOICE', quote: 'QUOTE', number: 'Number', issue: 'Date', due: 'Due', valid: 'Valid until',
    billTo: 'Bill to', quoteFor: 'Quote for', description: 'Description', qty: 'Qty', price: 'Price', amount: 'Amount',
    subtotal: 'Subtotal', discount: 'Discount', tax: 'Tax', taxIncluded: 'included', total: 'Total', paid: 'Paid', balance: 'Balance due',
    notes: 'Notes', terms: 'Terms', status: 'Status', void: 'VOID', paidStamp: 'PAID', page: 'Page',
  },
};

/** Core PDF fonts only cover WinAnsi (Latin-1): anything else would print as garbage. */
export const pdfSafe = (value: unknown): string =>
  String(value ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/gu, "?");

export interface PdfInput {
  doc: any; // SalesDocument (lean / plain)
  contact: { name?: string; company?: string; email?: string; phone?: string } | null;
  business: { name: string; email?: string; phone?: string; website?: string; address?: string[]; taxId?: string; footerNote?: string };
}

export function buildPdf({ doc, contact, business }: PdfInput): Promise<Buffer> {
  const lang: Lang = doc.language === 'en' ? 'en' : 'es';
  const t = T[lang];
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: doc.currency || 'USD' });
  const fmt = (cents: number) => pdfSafe(money.format((cents || 0) / 100));
  const date = (d?: Date | string) => (d ? new Date(d).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '-');
  const isQuote = doc.type === 'quote';

  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'LETTER', margin: 48, info: { Title: `${isQuote ? t.quote : t.invoice} ${doc.number}` } });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const L = 48;
    const R = pdf.page.width - 48;
    const W = R - L;
    const accent = '#1d4ed8';
    const muted = '#6b7280';

    // Header
    pdf.fillColor('#111827').font('Helvetica-Bold').fontSize(18).text(pdfSafe(business.name), L, 48, { width: W * 0.6 });
    pdf.font('Helvetica').fontSize(9).fillColor(muted);
    [business.taxId && `Tax ID: ${business.taxId}`, ...(business.address || []), business.email, business.phone, business.website]
      .filter(Boolean)
      .forEach((line) => pdf.text(pdfSafe(line), L, pdf.y, { width: W * 0.6 }));

    pdf.fillColor(accent).font('Helvetica-Bold').fontSize(22).text(isQuote ? t.quote : t.invoice, L, 48, { width: W, align: 'right' });
    pdf.fillColor('#111827').font('Helvetica').fontSize(10);
    pdf.text(`${t.number}: ${pdfSafe(doc.number)}`, L, 78, { width: W, align: 'right' });
    pdf.text(`${t.issue}: ${date(doc.issueDate)}`, L, pdf.y, { width: W, align: 'right' });
    if (doc.dueDate) pdf.text(`${isQuote ? t.valid : t.due}: ${date(doc.dueDate)}`, L, pdf.y, { width: W, align: 'right' });

    // Bill to
    pdf.y = Math.max(pdf.y, 130) + 16;
    pdf.fillColor(muted).font('Helvetica-Bold').fontSize(8).text((isQuote ? t.quoteFor : t.billTo).toUpperCase(), L, pdf.y);
    pdf.fillColor('#111827').font('Helvetica-Bold').fontSize(11).text(pdfSafe(contact?.name || '-'), L, pdf.y + 2);
    pdf.font('Helvetica').fontSize(9).fillColor(muted);
    [contact?.company, contact?.email, contact?.phone].filter(Boolean).forEach((x) => pdf.text(pdfSafe(x), L, pdf.y));

    // Table
    const col = { desc: L, qty: L + W * 0.52, price: L + W * 0.64, amt: L + W * 0.82 };
    const header = (y: number) => {
      pdf.rect(L, y, W, 20).fill(accent);
      pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
      pdf.text(t.description, col.desc + 6, y + 6, { width: W * 0.5 });
      pdf.text(t.qty, col.qty, y + 6, { width: W * 0.1, align: 'right' });
      pdf.text(t.price, col.price, y + 6, { width: W * 0.16, align: 'right' });
      pdf.text(t.amount, col.amt, y + 6, { width: W * 0.18 - 6, align: 'right' });
      return y + 24;
    };
    let y = header(pdf.y + 18);
    const bottom = () => pdf.page.height - 90;

    pdf.font('Helvetica').fontSize(9.5).fillColor('#111827');
    for (const line of doc.lines || []) {
      const desc = pdfSafe(line.description) + (line.discountPct ? `  (-${line.discountPct}%)` : '') + (line.taxable === false ? '' : '');
      const h = Math.max(16, pdf.heightOfString(desc, { width: W * 0.5 }) + 6);
      if (y + h > bottom()) {
        pdf.addPage();
        y = header(48);
        pdf.font('Helvetica').fontSize(9.5).fillColor('#111827');
      }
      pdf.text(desc, col.desc + 6, y, { width: W * 0.5 });
      pdf.text(String(line.quantity), col.qty, y, { width: W * 0.1, align: 'right' });
      pdf.text(fmt(line.unitPriceCents), col.price, y, { width: W * 0.16, align: 'right' });
      pdf.text(fmt(line.amountCents), col.amt, y, { width: W * 0.18 - 6, align: 'right' });
      y += h;
      pdf.moveTo(L, y - 3).lineTo(R, y - 3).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
    }

    // Totals
    const rows: [string, string, boolean?][] = [[t.subtotal, fmt(doc.subtotalCents)]];
    if (doc.discountCents) rows.push([`${t.discount} (${doc.discountPct}%)`, `-${fmt(doc.discountCents)}`]);
    if (doc.taxRatePct) rows.push([`${pdfSafe(doc.taxName || t.tax)} ${doc.taxRatePct}%${doc.taxIncluded ? ` (${t.taxIncluded})` : ''}`, fmt(doc.taxCents)]);
    rows.push([t.total, fmt(doc.totalCents), true]);
    if (!isQuote && doc.amountPaidCents) {
      rows.push([t.paid, `-${fmt(doc.amountPaidCents)}`]);
      rows.push([t.balance, fmt(doc.totalCents - doc.amountPaidCents), true]);
    }
    if (y + rows.length * 18 + 20 > bottom()) {
      pdf.addPage();
      y = 48;
    }
    y += 10;
    for (const [label, value, bold] of rows) {
      pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).fillColor('#111827');
      pdf.text(label, L + W * 0.5, y, { width: W * 0.28, align: 'right' });
      pdf.text(value, col.amt, y, { width: W * 0.18 - 6, align: 'right' });
      y += bold ? 20 : 16;
    }

    // Notes & terms
    const blocks: [string, string | undefined][] = [[t.notes, doc.notes], [t.terms, doc.terms]];
    for (const [title, body] of blocks) {
      if (!body?.trim()) continue;
      const h = pdf.heightOfString(pdfSafe(body), { width: W }) + 24;
      if (y + h > bottom()) {
        pdf.addPage();
        y = 48;
      }
      y += 12;
      pdf.fillColor(muted).font('Helvetica-Bold').fontSize(8).text(title.toUpperCase(), L, y);
      pdf.fillColor('#111827').font('Helvetica').fontSize(9).text(pdfSafe(body), L, pdf.y + 2, { width: W });
      y = pdf.y;
    }

    if (doc.status === 'void' || doc.status === 'paid') {
      pdf.save().rotate(-25, { origin: [pdf.page.width / 2, 300] });
      pdf.fillColor(doc.status === 'void' ? '#ef4444' : '#16a34a').opacity(0.15).font('Helvetica-Bold').fontSize(90);
      pdf.text(doc.status === 'void' ? t.void : t.paidStamp, 0, 260, { width: pdf.page.width, align: 'center' });
      pdf.restore();
    }

    if (business.footerNote) {
      pdf.opacity(1).fillColor(muted).font('Helvetica').fontSize(8).text(pdfSafe(business.footerNote), L, pdf.page.height - 60, { width: W, align: 'center' });
    }
    pdf.end();
  });
}
