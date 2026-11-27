import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { computeAverageCodesPerDay } from '../components/DispatchCentre';
import type { CsvPermitRecord } from '../utils/csvParser';

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

describe('Avg/day voucher usage calculation', () => {
  const refDate = new Date(2026, 10, 27, 15, 0, 0); // 2026-11-27 15:00 local

  it('returns 0 when database is empty or has no dispatched permits with codes', () => {
    const emptyAvg = computeAverageCodesPerDay({
      database: [],
      periodDays: 7,
      dispatchedKeysSet: new Set(),
      unsentKeysSet: new Set(),
      referenceDate: refDate
    });
    assert.equal(emptyAvg, 0);

    const noDispatchedAvg = computeAverageCodesPerDay({
      database: [
        makePermit({
          formId: '101',
          vrm: 'AB12CDE',
          voucherCode: 'VOUCH001',
          status: 'PENDING',
          completionTime: '2026-11-27 10:00:00'
        }),
        makePermit({
          formId: '102',
          vrm: 'FG34HIJ',
          voucherCode: '-',
          isDispatched: true,
          dispatchedAt: '2026-11-27 11:00:00'
        })
      ],
      periodDays: 7,
      dispatchedKeysSet: new Set(['102']),
      unsentKeysSet: new Set(),
      referenceDate: refDate
    });
    assert.equal(noDispatchedAvg, 0);
  });

  it('matches hand-counted totals across 7d, 14d, and 30d with replacements, exclusions, and date fallbacks', () => {
    const records: CsvPermitRecord[] = [
      // #1: Dispatched today via dispatchedAt, 1 code -> inside 7d, 14d, 30d (count = 1)
      makePermit({
        formId: '201',
        vrm: 'AA11AAA',
        dateRequired: '2026-11-02',
        voucherCode: 'CODE_201',
        isDispatched: true,
        dispatchedAt: '2026-11-27 09:30:00',
        completionTime: '2026-11-01 08:00:00' // older submission date, dispatchedAt wins
      }),
      // #2: Dispatched on start boundary of 7d window (2026-11-21), replacement resent -> 2 codes (original + replacement)
      makePermit({
        formId: '202',
        vrm: 'BB22BBB',
        dateRequired: '2026-11-21',
        originalVoucherCode: 'CODE_202_ORIG',
        voucherCode: 'CODE_202_NEW',
        status: 'SENT',
        completionTime: '2026-11-21 12:00:00' // fallback when dispatchedAt missing
      }),
      // #3: Dispatched 3 days ago with replacementCode field still present -> 2 codes
      makePermit({
        formId: '203',
        vrm: 'CC33CCC',
        dateRequired: '2026-11-24',
        voucherCode: 'CODE_203_ORIG',
        replacementCode: 'CODE_203_REP',
        dispatchedAt: '2026-11-24 14:15:00'
      }),
      // #4: Cancelled permit even though dispatched & coded -> EXCLUDED
      makePermit({
        formId: '204',
        vrm: 'DD44DDD',
        dateRequired: '2026-11-26',
        voucherCode: 'CODE_204',
        isDispatched: true,
        isCancelled: true,
        dispatchedAt: '2026-11-26 10:00:00'
      }),
      // #5: Explicitly unsent permit -> EXCLUDED
      makePermit({
        formId: '205',
        vrm: 'EE55EEE',
        dateRequired: '2026-11-26',
        voucherCode: 'CODE_205',
        isDispatched: true,
        dispatchedAt: '2026-11-26 11:00:00'
      }),
      // #6: Dispatched 8 days ago (2026-11-19) -> outside 7d, inside 14d & 30d (count = 1)
      makePermit({
        formId: '206',
        vrm: 'FF66FFF',
        dateRequired: '2026-11-19',
        voucherCode: 'CODE_206',
        createdAt: '2026-11-19 16:45:00' // dispatched via dispatchedKeysSet
      }),
      // #7: Dispatched 14th day ago boundary (2026-11-14) -> inside 14d & 30d (count = 1)
      makePermit({
        formId: '207',
        vrm: 'GG77GGG',
        dateRequired: '2026-11-14',
        voucherCode: 'CODE_207',
        isDispatched: true,
        dispatchedAt: '2026-11-14 00:05:00'
      }),
      // #8: Dispatched 20 days ago (2026-11-07) -> outside 7d & 14d, inside 30d (count = 1)
      makePermit({
        formId: '208',
        vrm: 'HH88HHH',
        dateRequired: '2026-11-07',
        voucherCode: 'CODE_208',
        isDispatched: true,
        dispatchedAt: '2026-11-07 13:00:00'
      }),
      // #9: Dispatched 31 days ago (2026-10-27) -> outside 30d (starts 2026-10-29) -> EXCLUDED from all
      makePermit({
        formId: '209',
        vrm: 'JJ99JJJ',
        dateRequired: '2026-10-27',
        voucherCode: 'CODE_209',
        isDispatched: true,
        dispatchedAt: '2026-10-27 12:00:00'
      })
    ];

    const dispatchedKeysSet = new Set(['206']);
    const unsentKeysSet = new Set(['205']);

    // 7d total = 1 (#1) + 2 (#2) + 2 (#3) = 5 codes => 5 / 7
    const avg7 = computeAverageCodesPerDay({
      database: records,
      periodDays: 7,
      dispatchedKeysSet,
      unsentKeysSet,
      referenceDate: refDate
    });
    assert.equal(avg7.toFixed(1), (5 / 7).toFixed(1)); // 0.7

    // 14d total = 5 + 1 (#6) + 1 (#7) = 7 codes => 7 / 14 = 0.5
    const avg14 = computeAverageCodesPerDay({
      database: records,
      periodDays: 14,
      dispatchedKeysSet,
      unsentKeysSet,
      referenceDate: refDate
    });
    assert.equal(avg14.toFixed(1), '0.5');

    // 30d total = 7 + 1 (#8) = 8 codes => 8 / 30
    const avg30 = computeAverageCodesPerDay({
      database: records,
      periodDays: 30,
      dispatchedKeysSet,
      unsentKeysSet,
      referenceDate: refDate
    });
    assert.equal(avg30.toFixed(1), (8 / 30).toFixed(1)); // 0.3
  });

  it('does not double-count when originalVoucherCode equals voucherCode, and resolves UK date strings via parseFullDateTimeMs', () => {
    const avg = computeAverageCodesPerDay({
      database: [
        makePermit({
          formId: '301',
          vrm: 'KK11LLL',
          dateRequired: '2026-11-26',
          voucherCode: 'SAME_CODE',
          originalVoucherCode: 'SAME_CODE',
          isDispatched: true,
          dispatchedAt: '26/11/2026 14:30:00'
        })
      ],
      periodDays: 7,
      dispatchedKeysSet: new Set(),
      unsentKeysSet: new Set(),
      referenceDate: refDate
    });
    assert.equal(avg, 1 / 7);
  });

  it('renders Avg/day chip to the left of For # box, cycles 7->14->30->7, persists period, and ignores table filters', { skip: !jsdomAvailable }, async () => {
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
    const dbRecords: CsvPermitRecord[] = Array.from({ length: 7 }, (_, idx) =>
      makePermit({
        formId: String(500 + idx),
        vrm: `AB1${idx}CDE`,
        dateRequired: todayIso,
        hospital: idx < 4 ? 'Newham Hospital' : 'Whipps Cross Hospital',
        ward: idx < 4 ? 'Maternity' : 'Acorn Ward',
        voucherCode: `CODE_50${idx}`,
        isDispatched: true,
        dispatchedAt: `${todayIso} 10:00:00`
      })
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: dbRecords,
          vouchersDatabase: [],
          dispatchedKeys: [],
          unsentKeys: [],
          processingDate: todayIso,
          onSelectRecord: () => {}
        })
      );
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    const avgBtn = buttons.find(b => b.textContent?.includes('Avg/day'));
    assert.ok(avgBtn, 'Avg/day chip button should render');
    assert.ok(avgBtn.textContent?.includes('1.0'), '7 codes over 7 days should display 1.0');
    assert.ok(avgBtn.textContent?.includes('7d'), 'Default period pill should display 7d');
    assert.equal(
      avgBtn.getAttribute('title'),
      'Average codes used per day over the last 7 days. Cancelled permits excluded. Click to change period.'
    );

    // Check Avg/day is to the left of Stock and "For #..." box in the same header container
    const headerChildren = Array.from(avgBtn.parentElement?.children || []);
    const avgIdx = headerChildren.indexOf(avgBtn);
    const forIdx = headerChildren.findIndex(el => el.textContent?.includes('For #'));
    assert.ok(avgIdx >= 0 && forIdx > avgIdx, 'Avg/day chip must appear to the left of For # box');

    // Cycle 7 -> 14
    await act(async () => {
      avgBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    });
    assert.ok(avgBtn.textContent?.includes('0.5'), '7 codes over 14 days should display 0.5');
    assert.ok(avgBtn.textContent?.includes('14d'));
    assert.equal(store['parkpass_avg_codes_period_days'], '14');

    // Apply a filter (e.g. search query matching only 1 record) and verify Avg/day ignores filters
    const searchInput = container.querySelector('input[placeholder*="Search driver"]') as HTMLInputElement;
    assert.ok(searchInput);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(searchInput, 'AB10CDE');
      searchInput.dispatchEvent(new win.Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
    assert.ok(avgBtn.textContent?.includes('0.5'), 'Avg/day must remain unchanged when search/table filters change');

    // Cycle 14 -> 30 -> 7
    await act(async () => {
      avgBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    });
    assert.ok(avgBtn.textContent?.includes('0.2'), '7 codes over 30 days should display 0.2');
    assert.ok(avgBtn.textContent?.includes('30d'));
    assert.equal(store['parkpass_avg_codes_period_days'], '30');

    await act(async () => {
      avgBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    });
    assert.ok(avgBtn.textContent?.includes('1.0'));
    assert.ok(avgBtn.textContent?.includes('7d'));
    assert.equal(store['parkpass_avg_codes_period_days'], '7');
  });
});
