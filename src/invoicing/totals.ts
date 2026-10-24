import { BadRequestException } from '@nestjs/common';

export interface LineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountPct?: number;
  taxable?: boolean;
}

export interface TotalsInput {
  lines: LineInput[];
  discountPct?: number;
  taxRatePct?: number;
  taxIncluded?: boolean;
}

export interface Totals {
  lines: (Required<Pick<LineInput, 'description' | 'quantity' | 'unitPriceCents'>> & { discountPct: number; taxable: boolean; amountCents: number })[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

const MAX_LINES = 100;
const MAX_TOTAL_CENTS = 10_000_000_000; // $100M, guards against typos and overflow

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Pure money math in integer cents. Rounding happens per step (line, document discount, tax) so the
 * numbers printed on the PDF always add up exactly.
 */
export function computeTotals(input: TotalsInput): Totals {
  const { lines } = input;
  if (!Array.isArray(lines) || lines.length === 0) throw new BadRequestException('Agrega al menos una línea');
  if (lines.length > MAX_LINES) throw new BadRequestException(`Máximo ${MAX_LINES} líneas`);

  const discountPct = input.discountPct ?? 0;
  const taxRatePct = input.taxRatePct ?? 0;
  if (!isNum(discountPct) || discountPct < 0 || discountPct > 100) throw new BadRequestException('Descuento inválido');
  if (!isNum(taxRatePct) || taxRatePct < 0 || taxRatePct > 100) throw new BadRequestException('Tasa de impuesto inválida');

  let subtotal = 0;
  let taxableNet = 0;
  const out: Totals['lines'] = lines.map((l, i) => {
    if (!l.description?.trim()) throw new BadRequestException(`La línea ${i + 1} necesita una descripción`);
    if (!isNum(l.quantity) || l.quantity <= 0 || l.quantity > 1_000_000) throw new BadRequestException(`Cantidad inválida en la línea ${i + 1}`);
    if (!isNum(l.unitPriceCents) || l.unitPriceCents < 0 || !Number.isInteger(l.unitPriceCents)) throw new BadRequestException(`Precio inválido en la línea ${i + 1}`);
    const lineDiscountPct = l.discountPct ?? 0;
    if (!isNum(lineDiscountPct) || lineDiscountPct < 0 || lineDiscountPct > 100) throw new BadRequestException(`Descuento inválido en la línea ${i + 1}`);

    const gross = Math.round(l.quantity * l.unitPriceCents);
    const amountCents = gross - Math.round((gross * lineDiscountPct) / 100);
    const taxable = l.taxable !== false;
    subtotal += amountCents;
    if (taxable) taxableNet += amountCents;
    return { description: l.description.trim(), quantity: l.quantity, unitPriceCents: l.unitPriceCents, discountPct: lineDiscountPct, taxable, amountCents };
  });

  const discountCents = Math.round((subtotal * discountPct) / 100);
  const taxableBase = taxableNet - Math.round((taxableNet * discountPct) / 100);

  let taxCents: number;
  let totalCents: number;
  if (input.taxIncluded) {
    // prices already contain the tax: the tax is the part of the taxable base that is tax
    taxCents = taxableBase - Math.round(taxableBase / (1 + taxRatePct / 100));
    totalCents = subtotal - discountCents;
  } else {
    taxCents = Math.round((taxableBase * taxRatePct) / 100);
    totalCents = subtotal - discountCents + taxCents;
  }

  if (totalCents > MAX_TOTAL_CENTS) throw new BadRequestException('El total excede el máximo permitido');
  return { lines: out, subtotalCents: subtotal, discountCents, taxCents, totalCents };
}
