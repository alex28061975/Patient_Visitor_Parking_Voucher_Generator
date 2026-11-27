import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { computeUnusedStockCount } from '../components/DispatchCentre';
import type { CsvPermitRecord, ParsedVoucherData } from '../utils/csvParser';

const require = createRequire(import.meta.url);
let jsdomAvailable = false;
let JSDOMClass: any = null;
try {
  const jsdomPkg = require('jsdom');
  JSDOMClass = jsdomPkg.JSDOM;
  jsdomAvailable = true;
} catch {
  jsdomAvailable = false;
}

const makePermit = (overrides: Partial<CsvPermitRecord>): CsvPermitRecord => ({
  id: String(overrides.formId || '1'),
  formId: '1',
  vrm: 'AB12CDE',
  hospital: 'Newham Hospital',
  ward: 'Maternity',
  dateRequired: '2026-11-27',
  driverName: 'Test Driver',
  ...overrides
});

const makeVoucher = (overrides: Partial<ParsedVoucherData>): ParsedVoucherData => ({
  code: 'VCH_DEFAULT',
  validFrom: '2026-11-27',
  validTo: '2026-12-03',
  status: 'active',
  ...overrides
});

describe('Stock runway chip & calculation', () => {
  const refDate = new Date(2026, 10, 27, 15, 0, 0); // 2026-11-27

  it('excludes expired, used, withdrawn, and assigned codes while counting across all future/today dates', () => {
    const vouchers: ParsedVoucherData[] = [
      // Unused valid today..next week -> INCLUDED (1)
      makeVoucher({ code: 'AVAIL_1', validFrom: '2026-11-21', validTo: '2026-11-27' }),
      // Unused valid in a completely different future week -> INCLUDED (2)
      makeVoucher({ code: 'AVAIL_2', validFrom: '2026-12-08', validTo: '2026-12-14' }),
      // Unused valid another future week -> INCLUDED (3)
      makeVoucher({ code: 'AVAIL_3', validFrom: '2026-12-15', validTo: '2026-12-21' }),
      // Expired yesterday -> EXCLUDED
      makeVoucher({ code: 'EXPIRED_1', validFrom: '2026-11-20', validTo: '2026-11-26' }),
      // Marked used on voucher object -> EXCLUDED
      makeVoucher({ code: 'USED_FLAG', isUsed: true }),
      // Marked status='used' / 'dispatched' / 'withdrawn' -> EXCLUDED
      makeVoucher({ code: 'USED_STATUS', status: 'used' }),
      makeVoucher({ code: 'DISPATCHED_STATUS', status: 'dispatched' }),
      makeVoucher({ code: 'WITHDRAWN_STATUS', status: 'withdrawn' }),
      // Assigned to an active permit in database -> EXCLUDED
      makeVoucher({ code: 'ASSIGNED_1' }),
      // Previously assigned to a cancelled non-dispatched permit -> RELEASED -> INCLUDED (4)
      makeVoucher({ code: 'RELEASED_CANCELLED' })
    ];

    const permits: CsvPermitRecord[] = [
      makePermit({ formId: '10', voucherCode: 'ASSIGNED_1', status: 'SENT', isDispatched: true }),
      makePermit({ formId: '11', voucherCode: 'RELEASED_CANCELLED', isCancelled: true, isDispatched: false })
    ];

    const stock = computeUnusedStockCount({
      vouchersDatabase: vouchers,
      database: permits,
      referenceDate: refDate
    });

    assert.equal(stock, 4);
  });

  it('shows Stock -- when avgCodesPerDay is 0', { skip: !jsdomAvailable }, async () => {
    const store: Record<string, string> = {};
    const dom = new JSDOMClass('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost/'
    });
    const win = dom.window;
    globalThis.window = win as any;
    globalThis.document = win.document;
    Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
    Object.defineProperty(win, 'localStorage', {
      value: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = String(v); },
        removeItem: (k: string) => { delete store[k]; },
        clear: () => { Object.keys(store).forEach(k => delete store[k]); }
      },
      configurable: true
    });
    globalThis.localStorage = win.localStorage;
    globalThis.matchMedia = win.matchMedia || ((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }) as any);
    globalThis.ResizeObserver = win.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
    globalThis.MutationObserver = win.MutationObserver || class { observe() {} disconnect() {} takeRecords() { return []; } };
    globalThis.MouseEvent = win.MouseEvent;
    globalThis.getComputedStyle = win.getComputedStyle;

    const React = await import('react');
    const ReactDOMClient = await import('react-dom/client');
    const { act } = await import('react');
    const { DispatchCentre } = await import('../components/DispatchCentre');

    const now = new Date();
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const futureTo = `${now.getFullYear() + 1}-01-10`;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: [],
          vouchersDatabase: [
            makeVoucher({ code: 'FREE_1', validFrom: todayIso, validTo: futureTo }),
            makeVoucher({ code: 'FREE_2', validFrom: todayIso, validTo: futureTo })
          ],
          dispatchedKeys: [],
          unsentKeys: [],
          processingDate: todayIso,
          onSelectRecord: () => {}
        })
      );
    });

    const spans = Array.from(container.querySelectorAll('span'));
    const stockChip = spans.find(s => s.getAttribute('title')?.includes('codes in stock'));
    assert.ok(stockChip, 'Stock chip span should render');
    assert.ok(stockChip.textContent?.includes('Stock'));
    assert.ok(stockChip.textContent?.includes('--'));
    assert.ok(stockChip.previousElementSibling?.textContent?.includes('Avg/day'));
    assert.ok(stockChip.nextElementSibling?.textContent?.includes('No permit selected') || stockChip.nextElementSibling?.textContent?.includes('For #'));
  });

  it('computes hand-counted runway, applies threshold colours, and stays unchanged when table filters change', { skip: !jsdomAvailable }, async () => {
    const store: Record<string, string> = {};
    const dom = new JSDOMClass('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost/'
    });
    const win = dom.window;
    globalThis.window = win as any;
    globalThis.document = win.document;
    Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
    Object.defineProperty(win, 'localStorage', {
      value: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = String(v); },
        removeItem: (k: string) => { delete store[k]; },
        clear: () => { Object.keys(store).forEach(k => delete store[k]); }
      },
      configurable: true
    });
    globalThis.localStorage = win.localStorage;
    globalThis.matchMedia = win.matchMedia || ((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }) as any);
    globalThis.ResizeObserver = win.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
    globalThis.MutationObserver = win.MutationObserver || class { observe() {} disconnect() {} takeRecords() { return []; } };
    globalThis.MouseEvent = win.MouseEvent;
    globalThis.getComputedStyle = win.getComputedStyle;

    const React = await import('react');
    const ReactDOMClient = await import('react-dom/client');
    const { act } = await import('react');
    const { DispatchCentre } = await import('../components/DispatchCentre');

    const now = new Date();
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const futureTo = `${now.getFullYear() + 1}-01-10`;
    const pastTo = '2020-01-01';

    // 7 dispatched permits today => 7 / 7 days = 1.0/day
    const permits: CsvPermitRecord[] = Array.from({ length: 7 }, (_, i) =>
      makePermit({
        formId: String(700 + i),
        vrm: `XY1${i}ABC`,
        hospital: i < 4 ? 'Newham Hospital' : 'Whipps Cross Hospital',
        ward: i < 4 ? 'Maternity' : 'Acorn Ward',
        dateRequired: todayIso,
        voucherCode: `USED_${i}`,
        isDispatched: true,
        dispatchedAt: `${todayIso} 09:00:00`
      })
    );

    // 10 available vouchers across two future weeks + 1 expired + 1 used => stock = 10
    // Runway = Math.floor(10 / 1.0) = 10 days -> Amber (7..13)
    const vouchers: ParsedVoucherData[] = [
      ...Array.from({ length: 5 }, (_, i) => makeVoucher({ code: `AVAIL_W1_${i}`, validFrom: todayIso, validTo: futureTo })),
      ...Array.from({ length: 5 }, (_, i) => makeVoucher({ code: `AVAIL_W2_${i}`, validFrom: '2099-01-01', validTo: '2099-01-07' })),
      makeVoucher({ code: 'OLD_EXPIRED', validFrom: '2020-01-01', validTo: pastTo }),
      makeVoucher({ code: 'ALREADY_USED', isUsed: true, validFrom: todayIso, validTo: futureTo })
    ];

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: permits,
          vouchersDatabase: vouchers,
          dispatchedKeys: [],
          unsentKeys: [],
          processingDate: todayIso,
          onSelectRecord: () => {}
        })
      );
    });

    const findStockChip = () =>
      Array.from(container.querySelectorAll('span')).find(s => s.getAttribute('title')?.includes('codes in stock'));

    let chip = findStockChip();
    assert.ok(chip);
    assert.ok(chip.textContent?.includes('Stock'));
    assert.ok(chip.textContent?.includes('~10d'), `Expected ~10d, got ${chip.textContent}`);
    assert.equal(
      chip.getAttribute('title'),
      '10 codes in stock ÷ 1.0 per day = about 10 days. Amber under 14 days, red under 7.'
    );
    assert.ok(chip.innerHTML.includes('text-amber-600'), '10 days should use amber colour');

    // Verify immediate order: Avg/day -> Stock -> For #...
    assert.ok(chip.previousElementSibling?.textContent?.includes('Avg/day'));
    assert.ok(chip.nextElementSibling?.textContent?.includes('For #'));

    // Change search/table filter and confirm Stock runway does not change
    const searchInput = container.querySelector('input[placeholder*="Search driver"]') as HTMLInputElement;
    assert.ok(searchInput);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(searchInput, 'XY10ABC');
      searchInput.dispatchEvent(new win.Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
    chip = findStockChip();
    assert.ok(chip?.textContent?.includes('~10d'), 'Stock runway must not change when table filter changes');

    // Cycle Avg/day to 14d => avg becomes 7/14 = 0.5/day => runway becomes Math.floor(10 / 0.5) = 20d -> Green (>= 14)
    const avgBtn = Array.from(container.querySelectorAll('[role="button"]')).find(b => b.textContent?.includes('Avg/day'));
    assert.ok(avgBtn);
    await act(async () => {
      avgBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    });
    chip = findStockChip();
    assert.ok(chip?.textContent?.includes('~20d'), `Expected ~20d after cycling to 14d, got ${chip?.textContent}`);
    assert.ok(chip?.innerHTML.includes('text-emerald-600'), '20 days should use green colour');
  });
});
