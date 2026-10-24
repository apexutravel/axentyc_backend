import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { parseSignedRequest } from './meta-data-deletion';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sign = (payload: object, secret: string) => {
  const p = b64url(JSON.stringify(payload));
  return `${b64url(createHmac('sha256', secret).update(p).digest())}.${p}`;
};

describe('Meta signed_request', () => {
  it('decodes a correctly signed request', () => {
    expect(parseSignedRequest(sign({ algorithm: 'HMAC-SHA256', user_id: '123' }, 's3cret'), 's3cret').user_id).toBe('123');
  });
  it('rejects wrong secret, tampering, garbage and missing secret', () => {
    const good = sign({ algorithm: 'HMAC-SHA256', user_id: '123' }, 's3cret');
    expect(() => parseSignedRequest(good, 'other')).toThrow(BadRequestException);
    const [sig] = good.split('.');
    expect(() => parseSignedRequest(`${sig}.${b64url(JSON.stringify({ user_id: '999' }))}`, 's3cret')).toThrow(BadRequestException);
    expect(() => parseSignedRequest('nonsense', 's3cret')).toThrow(BadRequestException);
    expect(() => parseSignedRequest('', 's3cret')).toThrow(BadRequestException);
    expect(() => parseSignedRequest(good, '')).toThrow(BadRequestException);
    expect(() => parseSignedRequest(sign({ algorithm: 'NONE', user_id: '1' }, 's3cret'), 's3cret')).toThrow(BadRequestException);
  });
});
