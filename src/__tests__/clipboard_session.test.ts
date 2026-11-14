import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startQrClipboardWrite, getRecordPrimaryKey, getRecordKeys, type ClipboardWriteSession } from '../utils/dispatchUtils';

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

class MockClipboardItem {
  items: Record<string, Blob | Promise<Blob>>;
  constructor(items: Record<string, Blob | Promise<Blob>>) {
    this.items = items;
  }
}

function setupJsdomWithClipboard(options?: { rejectWrite?: Error; omitClipboard?: boolean }) {
  const dom = new JSDOMClass('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/'
  });
  const win = dom.window;
  globalThis.window = win as any;
  globalThis.document = win.document;
  (globalThis as any).ClipboardItem = options?.omitClipboard ? undefined : MockClipboardItem;

  const events: string[] = [];
  const clipboardCalls: any[] = [];

  if (options?.omitClipboard) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'jsdom' },
      configurable: true
    });
  } else {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent: 'jsdom',
        clipboard: {
          write: (items: any[]) => {
            events.push('clipboard.write.called');
            clipboardCalls.push(items);
            const firstItem = items[0] as MockClipboardItem;
            const blobOrPromise = firstItem?.items?.['image/png'];
            return Promise.resolve(blobOrPromise).then((blob) => {
              if (options?.rejectWrite) {
                throw options.rejectWrite;
              }
              events.push(`clipboard.write.resolved:${blob?.type || 'unknown'}:${blob?.size || 0}`);
            });
          },
          writeText: async () => {}
        }
      },
      configurable: true
    });
  }

  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {}
  } as any;
  globalThis.matchMedia = win.matchMedia || ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  }) as any);
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
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number);
  (win as any).focus = () => {};
  (globalThis as any).window.focus = () => {};

  return { dom, win, events, clipboardCalls };
}

describe('Synchronous QR Clipboard Write Session (clipboard_session.test.ts)', { skip: !jsdomAvailable }, () => {

  it('startQrClipboardWrite calls navigator.clipboard.write synchronously and resolves deferred image/png Blob', async () => {
    const { events, clipboardCalls } = setupJsdomWithClipboard();

    const session = startQrClipboardWrite();
    // Synchronous call MUST happen before any microtask/await
    assert.equal(clipboardCalls.length, 1);
    assert.deepEqual(events, ['clipboard.write.called']);
    assert.ok(session.writePromise, 'writePromise must be returned');

    const testBlob = new Blob(['png-bytes'], { type: 'image/png' });
    session.resolveBlob(testBlob);
    await session.writePromise;

    assert.deepEqual(events, ['clipboard.write.called', 'clipboard.write.resolved:image/png:9']);
  });

  it('DispatchCentre Resend button invokes startQrClipboardWrite synchronously before async onResendRecord and passes clipboardSession', async () => {
    const { events, clipboardCalls } = setupJsdomWithClipboard();
    const React = await import('react');
    const ReactDOMClient = await import('react-dom/client');
    const { act } = await import('react');
    const { DispatchCentre } = await import('../components/DispatchCentre');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);

    const permit = {
      id: '1',
      formId: '100',
      vrm: 'AB12CDE',
      driverName: 'Test Driver',
      dateRequired: '2026-11-04',
      validFrom: '2026-11-04',
      validTo: '2026-11-10',
      hospital: 'Whipps Cross Hospital',
      ward: 'Acorn Ward',
      status: 'SENT',
      voucherCode: 'OLD111',
      replacementCode: 'NEW222',
      isResend: true,
      emailTemplate: 'replacement' as const
    };
    const keys = [getRecordPrimaryKey(permit), ...getRecordKeys(permit)].filter(Boolean) as string[];

    let receivedSession: ClipboardWriteSession | undefined;
    let clipboardCountInsideOnResend = -1;

    await act(async () => {
      root.render(
        React.createElement(DispatchCentre, {
          database: [permit],
          vouchersDatabase: [{ code: 'NEW222', validFrom: '2026-11-04', validTo: '2026-11-10', status: 'active' }],
          dispatchedKeys: keys,
          unsentKeys: [],
          dateRangeFilter: 'all',
          processingDate: '2026-11-04',
          onSelectRecord: () => {},
          onResendRecord: async (_rec, session) => {
            clipboardCountInsideOnResend = clipboardCalls.length;
            receivedSession = session;
            events.push('onResendRecord.invoked');
            session?.resolveBlob(new Blob(['qr'], { type: 'image/png' }));
            await session?.writePromise;
          },
          onUnsendRecord: () => {}
        })
      );
    });

    const resendBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Resend'));
    assert.ok(resendBtn, 'Resend button must be rendered');

    await act(async () => {
      resendBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    assert.equal(clipboardCountInsideOnResend, 1, 'navigator.clipboard.write must be called BEFORE onResendRecord runs');
    assert.ok(receivedSession?.writePromise, 'clipboardSession with writePromise must be passed to onResendRecord');
    assert.deepEqual(events, [
      'clipboard.write.called',
      'onResendRecord.invoked',
      'clipboard.write.resolved:image/png:2'
    ]);

    await act(async () => root.unmount());
    container.remove();
  });

  it('PermitCard sendOne consumes passed clipboardSession, awaits write before opening Outlook, and hides manual Copy QR image prompt on success', async () => {
    const { events, clipboardCalls, win } = setupJsdomWithClipboard();
    const React = await import('react');
    const ReactDOMClient = await import('react-dom/client');
    const { act } = await import('react');
    const { PermitCard } = await import('../components/PermitCard');

    // Mock window.open and anchor clicks to track exact ordering
    win.open = (url: string) => {
      events.push(`window.open:${String(url).slice(0, 15)}`);
      return null;
    };
    (globalThis as any).window.open = win.open;
    const origCreateElement = document.createElement.bind(document);
    document.createElement = ((tagName: string, options?: any) => {
      const el = origCreateElement(tagName, options);
      if (tagName.toLowerCase() === 'a') {
        el.click = () => {
          events.push(`anchor.click:${el.getAttribute('href')?.slice(0, 7) || ''}`);
        };
      }
      return el;
    }) as any;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);
    const cardRef: { current: any } = { current: null };

    const updatedRecord = {
      id: '1',
      formId: '100',
      vrm: 'AB12CDE',
      driverName: 'Test Driver',
      email: 'driver@example.com',
      dateRequired: '2026-11-04',
      validFrom: '2026-11-04',
      validTo: '2026-11-10',
      todayDate: '2026-11-04',
      submissionDate: '2026-11-04',
      hospital: 'Whipps Cross Hospital',
      ward: 'Acorn Ward',
      status: 'SENT',
      voucherCode: 'NEW222',
      voucherCodesText: 'NEW222',
      prePaidCode: 'NEW222',
      originalVoucherCode: 'OLD111'
    };

    await act(async () => {
      root.render(
        React.createElement(PermitCard, {
          ref: cardRef,
          data: {
            title: 'Whipps Cross Concession',
            site: 'Whipps Cross Hospital',
            name: 'Test Driver',
            phone: '',
            vrm: 'AB12CDE',
            validFrom: '2026-11-04',
            validTo: '2026-11-10',
            ward: 'Acorn Ward',
            email: 'driver@example.com',
            voucherCodesText: 'NEW222',
            qrOverride: ''
          },
          database: [updatedRecord],
          vouchersDatabase: [{ code: 'NEW222', validFrom: '2026-11-04', validTo: '2026-11-10', status: 'active' }]
        })
      );
    });

    const session = startQrClipboardWrite();
    assert.equal(clipboardCalls.length, 1);

    await act(async () => {
      await cardRef.current.sendOne(updatedRecord, {
        skipDispatch: true,
        isReplacement: true,
        clipboardSession: session
      });
    });

    // Should NOT invoke navigator.clipboard.write a second time inside sendOne/handleSendWithOutlook
    assert.equal(clipboardCalls.length, 1);

    const writeResolvedIdx = events.findIndex(e => e.startsWith('clipboard.write.resolved:image/png:'));
    const outlookOpenedIdx = events.findIndex(e => e.startsWith('window.open:') || e.startsWith('anchor.click:mailto:'));
    assert.ok(writeResolvedIdx !== -1, 'Clipboard PNG write must resolve');
    assert.ok(outlookOpenedIdx !== -1, 'Outlook compose must open');
    assert.ok(writeResolvedIdx < outlookOpenedIdx, 'Clipboard write must complete BEFORE Outlook opens');

    // Manual "Copy QR image" fallback prompt must NOT be displayed on success
    assert.equal(document.body.textContent?.includes('QR image not copied yet'), false);
    assert.equal(document.body.textContent?.includes('Copy QR image'), false);

    await act(async () => root.unmount());
    container.remove();
  });

  it('PermitCard displays manual Copy QR image fallback prompt only when automatic clipboard copy fails', async () => {
    const { win } = setupJsdomWithClipboard({ rejectWrite: new Error('NotAllowedError') });
    const React = await import('react');
    const ReactDOMClient = await import('react-dom/client');
    const { act } = await import('react');
    const { PermitCard } = await import('../components/PermitCard');

    win.open = () => null;
    (globalThis as any).window.open = win.open;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);
    const cardRef: { current: any } = { current: null };

    const updatedRecord = {
      id: '2',
      formId: '200',
      vrm: 'XY99ZAB',
      driverName: 'Fallback Driver',
      email: 'fallback@example.com',
      dateRequired: '2026-11-04',
      validFrom: '2026-11-04',
      validTo: '2026-11-10',
      todayDate: '2026-11-04',
      submissionDate: '2026-11-04',
      hospital: 'Whipps Cross Hospital',
      ward: 'Acorn Ward',
      status: 'SENT',
      voucherCode: 'FALLBACK222',
      voucherCodesText: 'FALLBACK222',
      prePaidCode: 'FALLBACK222'
    };

    await act(async () => {
      root.render(
        React.createElement(PermitCard, {
          ref: cardRef,
          data: {
            title: 'Whipps Cross Concession',
            site: 'Whipps Cross Hospital',
            name: 'Fallback Driver',
            phone: '',
            vrm: 'XY99ZAB',
            validFrom: '2026-11-04',
            validTo: '2026-11-10',
            ward: 'Acorn Ward',
            email: 'fallback@example.com',
            voucherCodesText: 'FALLBACK222',
            qrOverride: ''
          },
          database: [updatedRecord],
          vouchersDatabase: [{ code: 'FALLBACK222', validFrom: '2026-11-04', validTo: '2026-11-10', status: 'active' }]
        })
      );
    });

    const session = startQrClipboardWrite();

    await act(async () => {
      await cardRef.current.sendOne(updatedRecord, {
        skipDispatch: true,
        isReplacement: true,
        clipboardSession: session
      });
    });

    assert.ok(document.body.textContent?.includes('QR image not copied yet'), 'Manual fallback heading must appear on failure');
    assert.ok(document.body.textContent?.includes('Copy QR image'), 'Manual Copy QR image button must appear on failure');

    await act(async () => root.unmount());
    container.remove();
  });

});
