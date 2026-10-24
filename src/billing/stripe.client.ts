import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

const STRIPE_API = 'https://api.stripe.com/v1';
/** Webhook timestamps older than this are rejected (replay protection) */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/** Stripe expects application/x-www-form-urlencoded with bracket notation for nested data. */
export function encodeForm(data: Record<string, any>, prefix = ''): string[] {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item !== null && typeof item === 'object') pairs.push(...encodeForm(item, `${name}[${index}]`));
        else pairs.push(`${encodeURIComponent(`${name}[${index}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof value === 'object') {
      pairs.push(...encodeForm(value, name));
    } else {
      pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return pairs;
}

/** Verifies the `Stripe-Signature` header against the raw request body. Throws on any mismatch. */
export function verifyStripeSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (!header || !secret) throw new BadRequestException('Missing Stripe signature');

  const parts = header.split(',').map((p) => p.trim().split('='));
  const timestamp = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!timestamp || signatures.length === 0) throw new BadRequestException('Malformed Stripe signature');

  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new BadRequestException('Stripe signature timestamp outside tolerance');
  }

  const payload = `${timestamp}.${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody}`;
  const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('hex'));
  const valid = signatures.some((sig) => {
    const received = Buffer.from(sig);
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
  if (!valid) throw new BadRequestException('Invalid Stripe signature');
}

@Injectable()
export class StripeClient {
  private readonly logger = new Logger(StripeClient.name);

  constructor(private readonly config: ConfigService) {}

  get secretKey(): string {
    return this.config.get<string>('STRIPE_SECRET_KEY') || '';
  }

  get webhookSecret(): string {
    return this.config.get<string>('STRIPE_WEBHOOK_SECRET') || '';
  }

  get isConfigured(): boolean {
    return !!this.secretKey;
  }

  async request<T = any>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, any> = {}): Promise<T> {
    if (!this.isConfigured) throw new ServiceUnavailableException('Los pagos no están configurados todavía');

    const body = encodeForm(params).join('&');
    const url = method === 'GET' && body ? `${STRIPE_API}${path}?${body}` : `${STRIPE_API}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: method === 'GET' ? undefined : body,
    });

    const json = (await response.json().catch(() => ({}))) as any;
    if (!response.ok) {
      this.logger.error(`Stripe ${method} ${path} failed: ${json?.error?.message || response.status}`);
      throw new BadRequestException(json?.error?.message || 'Stripe request failed');
    }
    return json as T;
  }
}
