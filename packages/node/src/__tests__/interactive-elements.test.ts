import { describe, it, expect } from 'vitest';
import { collectInteractiveElements } from '../interactive-elements';

const ev = (k: string, el: Record<string, unknown>) => ({ k, d: { el } });

describe('collectInteractiveElements', () => {
  it('dedupes by sig and counts occurrences', () => {
    const out = collectInteractiveElements([
      ev('clk', { sig: 'a1', path: 'button[id=save]', tag: 'BUTTON', txt: 'Save' }),
      ev('clk', { sig: 'a1', path: 'button[id=save]', tag: 'BUTTON', txt: 'Save' }),
      ev('inp', { sig: 'b2', path: 'input[name=email]', tag: 'INPUT' }),
    ]);
    expect(out).toHaveLength(2);
    const save = out.find((e) => e.sig === 'a1')!;
    expect(save.count).toBe(2);
    expect(save.txt).toBe('Save');
  });

  it('ignores non-interaction events and elements without a sig', () => {
    const out = collectInteractiveElements([
      { k: 'err', d: { msg: 'boom' } },
      ev('clk', { tag: 'BUTTON' }), // no sig
    ]);
    expect(out).toEqual([]);
  });

  it('returns results sorted by descending count', () => {
    const out = collectInteractiveElements([
      ev('clk', { sig: 'x', path: 'p1' }),
      ev('clk', { sig: 'y', path: 'p2' }),
      ev('clk', { sig: 'y', path: 'p2' }),
    ]);
    expect(out[0].sig).toBe('y');
  });

  it('redacts token-like signatures and path values in summaries', () => {
    const secretSig = 'sig_sk_fake_abcdefghijklmnopqrstuvwxyz0123456789';
    const out = collectInteractiveElements([
      ev('clk', {
        sig: secretSig,
        path: 'button[data-secret="sk_fake_abcdefghijklmnopqrstuvwxyz"]',
        tag: 'BUTTON',
        txt: 'Pay sk_fake_abcdefghijklmnopqrstuvwxyz',
      }),
    ]);
    const serialized = JSON.stringify(out);

    expect(out[0]).toMatchObject({
      sig: '[REDACTED]',
      path: 'button[data-secret]',
      tag: 'BUTTON',
      txt: 'Pay [REDACTED]',
      count: 1,
    });
    expect(serialized).not.toContain(secretSig);
    expect(serialized).not.toContain('sk_fake_abcdefghijklmnopqrstuvwxyz');
  });
});
