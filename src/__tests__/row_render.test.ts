import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getRecordPrimaryKey, getRecordKeys } from '../utils/dispatchUtils';

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

describe('DispatchCentre Row Render & Replacement Lock Test Suite (row_render.test.ts)', { skip: !jsdomAvailable }, () => {
  function setupJsdom() {
    try {
      const dom = new JSDOMClass('<!doctype html><html><body><div id="root"></div></body></html>', {
        url: 'http://localhost/'
      });
      const win = dom.window;
      globalThis.window = win as any;
      globalThis.document = win.document;
      Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
      globalThis.localStorage = {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {}
      } as any;
      globalThis.matchMedia = win.matchMedia || ((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }) as any);
      globalThis.ResizeObserver = win.ResizeObserver || class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      globalThis.MutationObserver = win.MutationObserver || class {
        observe() {}
        disconnect() {}
        takeRecords() { return []; }
      };
      globalThis.MouseEvent = win.MouseEvent;
      globalThis.getComputedStyle = win.getComputedStyle;
      globalThis.requestAnimationFrame = win.requestAnimationFrame || ((cb: FrameRequestCallback) => setTimeout(cb, 0));
      return dom;
    } catch (err) {
      throw new Error(`Failed to initialize jsdom setup: ${err}`);
    }
  }

  const permitBase = {
    id: '1',
    formId: '100',
    vrm: 'AB12CDE',
    driverName: 'Test Driver',
    dateRequired: '2026-11-04',
    validFrom: '2026-11-04',
    validTo: '2026-11-10',
    hospital: 'Whipps Cross Hospital',
    ward: 'Acorn Ward',
    status: 'SENT'
  };

  it('Scenario 1: Permit already SENT, in dispatchedKeys, with replacementCode set', async () => {
    setupJsdom();
    const React = await import('react');
    const ReactDOMClient = await import('react-dom/client');
    const { act } = await import('react');
    const { DispatchCentre } = await import('../components/DispatchCentre');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    let sendCalls = 0;
    let resendCalls = 0;
    const mockOnSendRecord = () => { sendCalls++; };
    const mockOnResendRecord = () => { resendCalls++; };

    const permitScenario1 = {
      ...permitBase,
      replacementCode: 'REP_CODE_1',
      isResend: true,
      emailTemplate: 'replacement' as const
    };

    const keys = [getRecordPrimaryKey(permitScenario1), ...getRecordKeys(permitScenario1)].filter(Boolean) as string[];

    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: [permitScenario1],
          vouchersDatabase: [{ code: 'REP_CODE_1', validFrom: '2026-11-04', validTo: '2026-11-10', status: 'active' }],
          dispatchedKeys: keys,
          unsentKeys: [],
          dateRangeFilter: 'all',
          processingDate: '2026-11-04',
          formData: {
            id: '1',
            formId: '100',
            vrm: 'AB12CDE',
            replacementCode: 'REP_CODE_1',
            isResend: true,
            emailTemplate: 'replacement'
          },
          onSelectRecord: () => {},
          onSendRecord: mockOnSendRecord,
          onResendRecord: mockOnResendRecord,
          onUnsendRecord: () => {},
          onEditRecord: () => {}
        })
      );
    });

    const rowBefore = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('AB12CDE'));
    assert.ok(rowBefore, 'Row for permit AB12CDE must exist');
    assert.ok(rowBefore.textContent?.includes('REPLACEMENT'), 'Scenario 1: Row must show REPLACEMENT badge before click');
    assert.ok(rowBefore.textContent?.includes('Resend'), 'Scenario 1: Row must show Resend button before click');

    await act(async () => {
      rowBefore.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    const rowAfter = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('AB12CDE'));
    assert.ok(rowAfter, 'Row for permit AB12CDE must exist after click');
    assert.ok(rowAfter.textContent?.includes('REPLACEMENT'), 'Scenario 1: Row must show REPLACEMENT badge after click');
    assert.ok(rowAfter.textContent?.includes('Resend'), 'Scenario 1: Row must show Resend button after click');
    assert.equal(sendCalls, 0, 'Scenario 1: send mock was never called');
    assert.equal(resendCalls, 0, 'Scenario 1: resend mock was never called');
  });

  it('Scenario 2: Flip-flop (unsent -> sent -> unsent with replacement)', async () => {
    setupJsdom();
    const React = await import('react');
    const ReactDOMClient = await import('react-dom/client');
    const { act } = await import('react');
    const { DispatchCentre } = await import('../components/DispatchCentre');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    const permitScenario2 = {
      ...permitBase,
      replacementCode: 'REP_CODE_2',
      isResend: true,
      status: 'PENDING'
    };

    const keys = [getRecordPrimaryKey(permitScenario2), ...getRecordKeys(permitScenario2)].filter(Boolean) as string[];

    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: [permitScenario2],
          vouchersDatabase: [{ code: 'REP_CODE_2', validFrom: '2026-11-04', validTo: '2026-11-10', status: 'active' }],
          dispatchedKeys: [],
          unsentKeys: keys,
          dateRangeFilter: 'all',
          processingDate: '2026-11-04',
          formData: {
            id: '1',
            formId: '100',
            vrm: 'AB12CDE',
            replacementCode: 'REP_CODE_2',
            isResend: true,
            emailTemplate: 'replacement'
          },
          onSelectRecord: () => {},
          onResendRecord: () => {},
          onUnsendRecord: () => {}
        })
      );
    });

    let row = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('AB12CDE'));
    assert.ok(row, 'Row exists');
    assert.ok(row.textContent?.includes('REPLACEMENT'), 'Scenario 2a: Unsent with replacement shows REPLACEMENT');
    assert.ok(row.textContent?.includes('Resend'), 'Scenario 2a: Unsent with replacement shows Resend');

    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: [permitScenario2],
          vouchersDatabase: [{ code: 'REP_CODE_2', validFrom: '2026-11-04', validTo: '2026-11-10', status: 'active' }],
          dispatchedKeys: keys,
          unsentKeys: [],
          dateRangeFilter: 'all',
          processingDate: '2026-11-04',
          onSelectRecord: () => {},
          onResendRecord: () => {},
          onUnsendRecord: () => {}
        })
      );
    });

    row = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('AB12CDE'));
    assert.ok(row, 'Row exists');
    assert.ok(row.textContent?.includes('REPLACEMENT'), 'Scenario 2b: Marked sent still shows REPLACEMENT');
    assert.ok(row.textContent?.includes('Resend'), 'Scenario 2b: Marked sent still shows Resend');

    // Re-render as unsent again (unsentKeys = keys, dispatchedKeys = [])
    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: [permitScenario2],
          vouchersDatabase: [{ code: 'REP_CODE_2', validFrom: '2026-11-04', validTo: '2026-11-10', status: 'active' }],
          dispatchedKeys: [],
          unsentKeys: keys,
          dateRangeFilter: 'all',
          processingDate: '2026-11-04',
          onSelectRecord: () => {},
          onResendRecord: () => {},
          onUnsendRecord: () => {}
        })
      );
    });

    row = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('AB12CDE'));
    assert.ok(row, 'Row exists');
    assert.ok(row.textContent?.includes('REPLACEMENT'), 'Scenario 2c: Unsent again still shows REPLACEMENT');
    assert.ok(row.textContent?.includes('Resend'), 'Scenario 2c: Unsent again still shows Resend');
  });

  it('Scenario 3: Resend pressed and completed successfully', async () => {
    setupJsdom();
    const React = await import('react');
    const ReactDOMClient = await import('react-dom/client');
    const { act } = await import('react');
    const { DispatchCentre } = await import('../components/DispatchCentre');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    let resendCalls = 0;
    const mockOnResendRecord = () => { resendCalls++; };

    const permitScenario3Active = {
      ...permitBase,
      replacementCode: 'REP_CODE_3',
      isResend: true,
      emailTemplate: 'replacement' as const
    };

    const keys = [getRecordPrimaryKey(permitScenario3Active), ...getRecordKeys(permitScenario3Active)].filter(Boolean) as string[];

    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: [permitScenario3Active],
          vouchersDatabase: [{ code: 'REP_CODE_3', validFrom: '2026-11-04', validTo: '2026-11-10', status: 'active' }],
          dispatchedKeys: keys,
          unsentKeys: [],
          dateRangeFilter: 'all',
          processingDate: '2026-11-04',
          formData: {
            id: '1',
            formId: '100',
            vrm: 'AB12CDE',
            replacementCode: 'REP_CODE_3',
            isResend: true,
            emailTemplate: 'replacement'
          },
          onSelectRecord: () => {},
          onResendRecord: mockOnResendRecord,
          onUnsendRecord: () => {}
        })
      );
    });

    const resendBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Resend'));
    await act(async () => {
      resendBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(resendCalls, 1, 'Scenario 3: onResendRecord called exactly once');

    const permitScenario3Completed = {
      ...permitBase,
      voucherCode: 'REP_CODE_3',
      prePaidCode: 'REP_CODE_3',
      originalVoucherCode: 'OLD_CODE',
      replacementCode: undefined,
      isResend: false,
      emailType: undefined,
      emailTemplate: undefined,
      status: 'SENT'
    };

    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: [permitScenario3Completed],
          vouchersDatabase: [{ code: 'REP_CODE_3', validFrom: '2026-11-04', validTo: '2026-11-10', status: 'active' }],
          dispatchedKeys: keys,
          unsentKeys: [],
          dateRangeFilter: 'all',
          processingDate: '2026-11-04',
          onSelectRecord: () => {},
          onResendRecord: mockOnResendRecord,
          onUnsendRecord: () => {}
        })
      );
    });

    const row = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('AB12CDE'));
    assert.ok(row, 'Row exists');
    assert.ok(row.textContent?.includes('SENT'), 'Scenario 3: Completed resend shows SENT');
    assert.ok(row.textContent?.includes('Unsend'), 'Scenario 3: Completed resend shows Unsend');
    assert.equal(row.textContent?.includes('REPLACEMENT'), false, 'Scenario 3: REPLACEMENT badge not shown in row');
  });

  it('Scenario D: Stale local state after a completed resend', async () => {
    setupJsdom();
    const React = await import('react');
    const ReactDOMClient = await import('react-dom/client');
    const { act } = await import('react');
    const { DispatchCentre } = await import('../components/DispatchCentre');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    const permitStaleActive = {
      ...permitBase,
      replacementCode: 'NEW222',
      isResend: true,
      emailType: 'RESEND_CONCESSION',
      emailTemplate: 'replacement' as const
    };

    const keys = [getRecordPrimaryKey(permitStaleActive), ...getRecordKeys(permitStaleActive)].filter(Boolean) as string[];

    const staleFormData = {
      id: '1',
      formId: '100',
      vrm: 'AB12CDE',
      replacementCode: 'NEW222',
      isResend: true,
      emailType: 'RESEND_CONCESSION',
      emailTemplate: 'replacement'
    };

    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: [permitStaleActive],
          vouchersDatabase: [{ code: 'NEW222', validFrom: '2026-11-04', validTo: '2026-11-10', status: 'active' }],
          dispatchedKeys: keys,
          unsentKeys: [],
          dateRangeFilter: 'all',
          processingDate: '2026-11-04',
          formData: staleFormData,
          onSelectRecord: () => {},
          onResendRecord: () => {},
          onUnsendRecord: () => {}
        })
      );
    });

    let row = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('AB12CDE'));
    assert.ok(row, 'Row exists');
    assert.ok(row.textContent?.includes('REPLACEMENT'), 'Scenario D: Stale active state shows REPLACEMENT');
    assert.ok(row.textContent?.includes('Resend'), 'Scenario D: Stale active state shows Resend');

    await act(async () => {
      row?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    row = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('AB12CDE'));
    assert.ok(row, 'Row exists');
    assert.ok(row.textContent?.includes('REPLACEMENT'), 'Scenario D: Selected row still shows REPLACEMENT');
    assert.ok(row.textContent?.includes('Resend'), 'Scenario D: Selected row still shows Resend');

    const permitCompleted = {
      ...permitBase,
      voucherCode: 'NEW222',
      replacementCode: undefined,
      isResend: false,
      emailType: undefined,
      emailTemplate: undefined,
      status: 'SENT'
    };

    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: [permitCompleted],
          vouchersDatabase: [{ code: 'NEW222', validFrom: '2026-11-04', validTo: '2026-11-10', status: 'active' }],
          dispatchedKeys: keys,
          unsentKeys: [],
          dateRangeFilter: 'all',
          processingDate: '2026-11-04',
          formData: staleFormData,
          onSelectRecord: () => {},
          onResendRecord: () => {},
          onUnsendRecord: () => {}
        })
      );
    });

    const rowCompleted = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('AB12CDE'));
    assert.ok(rowCompleted, 'Row exists');
    assert.ok(rowCompleted.textContent?.includes('SENT'), 'Scenario D: Completed resend with stale form data shows SENT');
    assert.ok(rowCompleted.textContent?.includes('Unsend'), 'Scenario D: Completed resend with stale form data shows Unsend');
    assert.equal(rowCompleted.textContent?.includes('REPLACEMENT'), false, 'Scenario D: REPLACEMENT badge is cleared despite stale form data');
  });

  it('Scenario E: Local-only replacement assignment on already-SENT permit', async () => {
    setupJsdom();
    const React = await import('react');
    const ReactDOMClient = await import('react-dom/client');
    const { act } = await import('react');
    const { DispatchCentre } = await import('../components/DispatchCentre');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    const permitLocalOnly = {
      ...permitBase,
      voucherCode: 'OLD_CODE_1',
      replacementCode: undefined,
      status: 'SENT'
    };

    const keys = [getRecordPrimaryKey(permitLocalOnly), ...getRecordKeys(permitLocalOnly)].filter(Boolean) as string[];

    const localFormData = {
      id: '1',
      formId: '100',
      vrm: 'AB12CDE',
      replacementCode: 'NEW_REP_999',
      isResend: true,
      emailType: 'RESEND_CONCESSION',
      emailTemplate: 'replacement' as const
    };

    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: [permitLocalOnly],
          vouchersDatabase: [{ code: 'NEW_REP_999', validFrom: '2026-11-04', validTo: '2026-11-10', status: 'active' }],
          dispatchedKeys: keys,
          unsentKeys: [],
          dateRangeFilter: 'all',
          processingDate: '2026-11-04',
          formData: localFormData,
          onSelectRecord: () => {},
          onResendRecord: () => {},
          onUnsendRecord: () => {}
        })
      );
    });

    let row = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('AB12CDE'));
    assert.ok(row, 'Row exists');
    assert.ok(row.textContent?.includes('REPLACEMENT'), 'Scenario E1: Local-only replacement shows REPLACEMENT');
    assert.ok(row.textContent?.includes('Resend'), 'Scenario E1: Local-only replacement shows Resend');

    // Simulate database refresh / re-render where database record still has no replacementCode
    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: [permitLocalOnly],
          vouchersDatabase: [{ code: 'NEW_REP_999', validFrom: '2026-11-04', validTo: '2026-11-10', status: 'active' }],
          dispatchedKeys: keys,
          unsentKeys: [],
          dateRangeFilter: 'all',
          processingDate: '2026-11-04',
          formData: localFormData,
          onSelectRecord: () => {},
          onResendRecord: () => {},
          onUnsendRecord: () => {}
        })
      );
    });

    row = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('AB12CDE'));
    assert.ok(row, 'Row exists');
    assert.ok(row.textContent?.includes('REPLACEMENT'), 'Scenario E2: REPLACEMENT remains visible after refresh');
    assert.ok(row.textContent?.includes('Resend'), 'Scenario E2: Resend remains visible after refresh');

    // Simulate successful resend cleanup
    const permitCompletedLocal = {
      ...permitLocalOnly,
      voucherCode: 'NEW_REP_999',
      replacementCode: undefined,
      isResend: false,
      emailType: undefined,
      emailTemplate: undefined
    };

    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: [permitCompletedLocal],
          vouchersDatabase: [{ code: 'NEW_REP_999', validFrom: '2026-11-04', validTo: '2026-11-10', status: 'active' }],
          dispatchedKeys: keys,
          unsentKeys: [],
          dateRangeFilter: 'all',
          processingDate: '2026-11-04',
          formData: localFormData,
          onSelectRecord: () => {},
          onResendRecord: () => {},
          onUnsendRecord: () => {}
        })
      );
    });

    row = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('AB12CDE'));
    assert.ok(row, 'Row exists');
    assert.ok(row.textContent?.includes('SENT'), 'Scenario E3: Successful resend changes row to SENT');
    assert.ok(row.textContent?.includes('Unsend'), 'Scenario E3: Successful resend changes row to Unsend');
    assert.equal(row.textContent?.includes('REPLACEMENT'), false, 'Scenario E3: REPLACEMENT badge is not shown');
  });

  it('Scenario F: Selecting a SENT row with stale legacy replacement flags does not activate replacement', async () => {
    setupJsdom();
    const React = await import('react');
    const ReactDOMClient = await import('react-dom/client');
    const { act } = await import('react');
    const { DispatchCentre } = await import('../components/DispatchCentre');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    const staleFlagsOnly = {
      ...permitBase,
      status: 'SENT',
      isDispatched: true,
      replacementCode: undefined,
      originalVoucherCode: 'OLD_CODE',
      isResend: true,
      emailType: 'RESEND_CONCESSION',
      emailTemplate: 'replacement' as const
    };
    const keys = [getRecordPrimaryKey(staleFlagsOnly), ...getRecordKeys(staleFlagsOnly)].filter(Boolean) as string[];

    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: [staleFlagsOnly],
          vouchersDatabase: [],
          dispatchedKeys: keys,
          unsentKeys: [],
          dateRangeFilter: 'all',
          processingDate: '2026-11-04',
          formData: {
            id: staleFlagsOnly.id,
            formId: staleFlagsOnly.formId,
            vrm: staleFlagsOnly.vrm,
            originalVoucherCode: 'OLD_CODE',
            replacementCode: undefined,
            isResend: true,
            emailType: 'RESEND_CONCESSION',
            emailTemplate: 'replacement'
          },
          onSelectRecord: () => {},
          onResendRecord: () => {},
          onUnsendRecord: () => {}
        })
      );
    });

    let row = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('AB12CDE'));
    assert.ok(row, 'Scenario F: Row exists');
    assert.ok(row.textContent?.includes('SENT'), 'Scenario F: Existing permit remains SENT');
    assert.ok(row.textContent?.includes('Unsend'), 'Scenario F: Existing permit retains Unsend');
    assert.equal(row.textContent?.includes('REPLACEMENT'), false, 'Scenario F: Legacy flags do not display REPLACEMENT');
    assert.equal(row.textContent?.includes('Resend'), false, 'Scenario F: Legacy flags do not display Resend');

    await act(async () => {
      row?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    row = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('AB12CDE'));
    assert.ok(row, 'Scenario F: Row remains rendered after selection');
    assert.equal(row.textContent?.includes('REPLACEMENT'), false, 'Scenario F: Row selection cannot activate REPLACEMENT');
    assert.equal(row.textContent?.includes('Resend'), false, 'Scenario F: Row selection cannot activate Resend');

    await act(async () => root.unmount());
    container.remove();
  });

});
