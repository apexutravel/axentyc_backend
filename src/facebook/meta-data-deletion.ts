import { createHmac, timingSafeEqual } from 'crypto';
import { BadRequestException } from '@nestjs/common';

const b64urlToBuffer = (v: string) => Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Verifies and decodes the `signed_request` Meta sends to the data deletion callback:
 * `<base64url signature>.<base64url payload>` signed with HMAC-SHA256 using the app secret.
 */
export function parseSignedRequest(signedRequest: string, appSecret: string): { user_id?: string; [k: string]: any } {
  if (!signedRequest || !appSecret || typeof signedRequest !== 'string') throw new BadRequestException('Invalid signed request');
  const [sig, payload] = signedRequest.split('.');
  if (!sig || !payload) throw new BadRequestException('Invalid signed request');

  const expected = createHmac('sha256', appSecret).update(payload).digest();
  const received = b64urlToBuffer(sig);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new BadRequestException('Invalid signature');
  }
  try {
    const data = JSON.parse(b64urlToBuffer(payload).toString('utf8'));
    if (data?.algorithm && String(data.algorithm).toUpperCase() !== 'HMAC-SHA256') throw new Error('algorithm');
    return data;
  } catch {
    throw new BadRequestException('Invalid payload');
  }
}
