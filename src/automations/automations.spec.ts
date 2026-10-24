import { matchesConditions, renderTemplate } from './automation-engine.service';
import { isPrivateAddress, safePostJson } from './safe-fetch';

describe('matchesConditions', () => {
  const ev = { channel: 'facebook', text: 'Hola, quiero un PRESUPUESTO', stage: 'proposal', status: 'open' };
  it('empty conditions always match', () => {
    expect(matchesConditions(undefined, ev)).toBe(true);
    expect(matchesConditions({}, ev)).toBe(true);
  });
  it('channel / stage / status', () => {
    expect(matchesConditions({ channel: 'facebook' }, ev)).toBe(true);
    expect(matchesConditions({ channel: 'instagram' }, ev)).toBe(false);
    expect(matchesConditions({ channel: 'any' }, ev)).toBe(true);
    expect(matchesConditions({ stage: 'negotiation' }, ev)).toBe(false);
    expect(matchesConditions({ status: 'open' }, ev)).toBe(true);
  });
  it('keywords are case-insensitive "any of"; no text never matches a keyword rule', () => {
    expect(matchesConditions({ keywords: ['precio', 'presupuesto'] }, ev)).toBe(true);
    expect(matchesConditions({ keywords: ['garantía'] }, ev)).toBe(false);
    expect(matchesConditions({ keywords: ['hola'] }, { channel: 'facebook', text: '' })).toBe(false);
    expect(matchesConditions({ keywords: ['', ''] }, ev)).toBe(false);
  });
  it('tags are matched against the contact', () => {
    expect(matchesConditions({ tags: ['VIP'] }, ev, ['vip'])).toBe(true);
    expect(matchesConditions({ tags: ['vip'] }, ev, ['otro'])).toBe(false);
    expect(matchesConditions({ tags: ['vip'] }, ev, [])).toBe(false);
  });
});

describe('renderTemplate', () => {
  it('fills contact and message variables', () => {
    expect(renderTemplate('Hola {{contact.firstName}}, recibimos: {{ message }}', { contactName: 'Ana María López', message: 'info' })).toBe('Hola Ana, recibimos: info');
    expect(renderTemplate('Hola {{contact.name}}!', { contactName: 'Ana María' })).toBe('Hola Ana María!');
  });
  it('missing data never leaves raw placeholders or throws', () => {
    expect(renderTemplate('Hola {{contact.firstName}} {{message}}', {})).toBe('Hola');
    expect(renderTemplate(undefined as any, {})).toBe('');
  });
});

describe('webhook SSRF guard', () => {
  it('flags non-public addresses', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '224.0.0.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });
  it('refuses http, credentials, internal hosts and garbage before any request', async () => {
    await expect(safePostJson('http://example.com/hook', {})).rejects.toThrow(/https/);
    await expect(safePostJson('https://user:pass@example.com/hook', {})).rejects.toThrow(/credenciales/);
    await expect(safePostJson('https://127.0.0.1/hook', {})).rejects.toThrow(/público/);
    await expect(safePostJson('https://169.254.169.254/latest/meta-data', {})).rejects.toThrow(/público/);
    await expect(safePostJson('https://[::1]/hook', {})).rejects.toThrow(/público/);
    await expect(safePostJson('not a url', {})).rejects.toThrow(/inválida/);
  });
});
