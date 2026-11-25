import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';

import {
  executeReplacementResendTransaction,
  type EmailTrackingInfo,
  type DispatchStateSnapshot
} from '../App';
import {
  BLOCKLIST_STORAGE_KEY,
  getBlocklist,
  getBlocklistSyncStatus,
  saveBlocklist,
  hydrateBlocklistFromServer,
  isVrmSilentBlocked,
  isVrmSilentBlockedSync,
  type BlocklistItem
} from '../lib/blocklist';
import { safeLocalStorage } from '../utils/safeLocalStorage';
import type { CsvPermitRecord, ParsedVoucherData } from '../utils/csvParser';
import type { PermitData } from '../types';

function createMockSupabase(options?: {
  initialBlocklistRows?: any[];
  failBlocklistSelect?: boolean;
  failBlocklistUpsert?: boolean;
  missingBlocklistSchema?: boolean;
}) {
  const rpcCalls: Array<{ fn: string; args: any }> = [];
  let blocklistRows: any[] = options?.initialBlocklistRows ? [...options.initialBlocklistRows] : [
    {
      id: 'blk_seed_1',
      form_id: '1311',
      hospital_site: 'Whipps Cross Hospital',
      ward_dept: 'Emergency Care',
      date_required: '2025-05-10',
      vrm: 'AU67 HCZ',
      driver_name: 'Sarah Connor',
      voucher_code: 'BLOCKED',
      reason: 'Duplicate permit abuse',
      added_at: '2025-05-10T08:00:00.000Z'
    }
  ];

  const buildResult = (res: any) => ({
    ...res,
    range: () => buildResult(res),
    order: () => buildResult(res),
    gte: () => buildResult(res),
    eq: () => buildResult(res),
    neq: () => buildResult(res),
    in: () => buildResult(res),
  });

  const client = {
    async rpc(fn: string, args: any) {
      rpcCalls.push({ fn, args });
      if (fn === 'replace_blocklist') {
        if (options?.missingBlocklistSchema) {
          return {
            data: null,
            error: {
              code: 'PGRST202',
              message: 'Could not find the function public.replace_blocklist(entries) in the schema cache'
            }
          };
        }
        // Atomic PostgreSQL transaction semantics:
        // If upsert/replacement fails, ALL changes roll back so existing rows stay intact!
        if (options?.failBlocklistUpsert) {
          return { data: null, error: { message: 'Supabase upsert failure' } };
        }
        const incoming = Array.isArray(args?.entries) ? args.entries : [];
        // Replace atomically inside the simulated transaction
        blocklistRows = incoming.map((row: any) => ({ ...row }));
        return { data: [...blocklistRows], error: null };
      }
      return { data: null, error: null };
    },
    from(table: string) {
      if (table === 'blocklist') {
        return {
          select: async () => {
            if (options?.missingBlocklistSchema) {
              return {
                data: null,
                error: {
                  code: 'PGRST205',
                  message: "Could not find the table 'public.blocklist' in the schema cache"
                }
              };
            }
            if (options?.failBlocklistSelect) {
              return { data: null, error: { message: 'Supabase select failure' } };
            }
            return { data: [...blocklistRows], error: null };
          }
        };
      }

      if (table === 'permits') {
        return {
          select: (_cols?: string, opts?: any) => {
            if (opts?.head) {
              return Promise.resolve({ count: 1, error: null });
            }
            const resPromise = Promise.resolve({
              data: [{ id: '1001', hospital: 'Whipps Cross', ward: 'Acorn', date_required: '2026-10-01', vrm: 'AB12CDE', driver_name: 'Jane' }],
              error: null
            });
            return Object.assign(resPromise, buildResult(resPromise));
          },
          update: () => ({
            eq: async () => ({ error: null })
          }),
          upsert: async () => ({ error: null }),
          delete: () => ({
            neq: async () => ({ error: null })
          })
        };
      }

      if (table === 'vouchers') {
        return {
          select: () => {
            const p = Promise.resolve({ data: [], error: null });
            return Object.assign(p, buildResult(p));
          },
          upsert: async () => ({ error: null }),
          delete: () => ({
            neq: async () => ({ error: null })
          })
        };
      }

      if (table === 'dispatched_history') {
        return {
          select: () => {
            const p = Promise.resolve({ data: [], error: null });
            return Object.assign(p, buildResult(p));
          },
          upsert: async () => ({ error: null }),
          delete: () => ({
            in: async () => ({ error: null }),
            eq: async () => ({ error: null }),
            neq: async () => ({ error: null })
          })
        };
      }

      return {
        select: async () => ({ data: [], error: null }),
        upsert: async () => ({ error: null }),
        delete: () => ({ neq: async () => ({ error: null }) })
      };
    }
  };

  return {
    client,
    rpcCalls,
    getBlocklistRows: () => [...blocklistRows]
  };
}

async function startTestServer(
  opts: {
    adminSecret?: string;
    nodeEnv?: string;
    trustedProxyCidrs?: string;
    trustedGatewayHeader?: string;
    vercelRuntime?: boolean;
    resolveRemoteAddress?: (req: any) => string | undefined;
    mockOpts?: Parameters<typeof createMockSupabase>[0];
  } = {}
) {
  process.env.SKIP_SERVER_LISTEN = '1';
  const { createApiApp } = await import('../../server');
  const mockSb = createMockSupabase(opts.mockOpts);
  const app = createApiApp({
    adminSecret: opts.adminSecret,
    nodeEnv: opts.nodeEnv,
    trustedProxyCidrs: opts.trustedProxyCidrs,
    trustedGatewayHeader: opts.trustedGatewayHeader,
    vercelRuntime: opts.vercelRuntime,
    resolveRemoteAddress: opts.resolveRemoteAddress,
    supabaseClient: mockSb.client
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    mockSb,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

describe('Third Audit Corrective Fixes Suite', () => {

  // =========================================================================
  // 1. Secret Removal, Trusted Access Boundary & Production Fail-Closed
  // =========================================================================
  it('1a. GET /api/config never discloses ADMIN_API_SECRET and local trusted loopback access works without login or tokens', async () => {
    const SECRET = 'server-only-secret-never-sent-to-browser';
    const srv = await startTestServer({ adminSecret: SECRET });
    try {
      const healthRes = await fetch(`${srv.baseUrl}/api/health`);
      assert.equal(healthRes.status, 200);

      const cfgRes = await fetch(`${srv.baseUrl}/api/config`);
      assert.equal(cfgRes.status, 200);
      const cfg = await cfgRes.json();
      assert.equal(cfg.adminToken, undefined, 'adminToken must never be exposed by /api/config');
      assert.equal(JSON.stringify(cfg).includes(SECRET), false, 'Secret must not appear anywhere in /api/config response');
      assert.ok(cfg.supabaseUrl);
      assert.ok(cfg.supabaseAnonKey);

      // Local trusted loopback client (no X-Admin-Token needed) can access admin endpoints directly
      const permitsRes = await fetch(`${srv.baseUrl}/api/permits`);
      assert.equal(permitsRes.status, 200);

      // Spoofed Origin header without server token does NOT bypass or break trusted interface checks unless external peer
      const dispatchBadBody = await fetch(`${srv.baseUrl}/api/admin/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: '' })
      });
      assert.equal(dispatchBadBody.status, 400);
    } finally {
      await srv.close();
    }
  });

  it('1b. Untrusted public network requests receive 401 without valid server-side X-Admin-Token and cannot spoof Origin/Referer', async () => {
    const SECRET = 'unit-test-server-secret-999';
    const srv = await startTestServer({
      adminSecret: SECRET,
      resolveRemoteAddress: () => '203.0.113.50' // public non-RFC1918 IP
    });
    try {
      const protectedRequests: Array<{ method: string; path: string; body?: any }> = [
        { method: 'GET', path: '/api/permits' },
        { method: 'POST', path: '/api/permits/update', body: { id: '1001', vrm: 'AB12CDE' } },
        { method: 'GET', path: '/api/vouchers' },
        { method: 'GET', path: '/api/dispatched' },
        { method: 'POST', path: '/api/admin/dispatch', body: { key: '1001', vrm: 'AB12CDE' } },
        { method: 'GET', path: '/api/blocklist' },
        { method: 'POST', path: '/api/blocklist', body: { items: [] } },
        { method: 'POST', path: '/api/emails/resend', body: { recordKey: '1001', vrm: 'AB12CDE', requestedCode: 'CODE123' } },
        { method: 'GET', path: '/api/emails/statuses' }
      ];

      // Untrusted IP without token (even with spoofed same-origin Origin/Referer) -> 401
      for (const reqSpec of protectedRequests) {
        const res = await fetch(`${srv.baseUrl}${reqSpec.path}`, {
          method: reqSpec.method,
          headers: {
            'Origin': srv.baseUrl,
            'Referer': `${srv.baseUrl}/`,
            ...(reqSpec.body ? { 'Content-Type': 'application/json' } : {})
          },
          body: reqSpec.body ? JSON.stringify(reqSpec.body) : undefined
        });
        assert.equal(res.status, 401, `Expected 401 from untrusted IP for ${reqSpec.method} ${reqSpec.path}`);
      }

      // Wrong X-Admin-Token -> 401
      const wrongRes = await fetch(`${srv.baseUrl}/api/permits`, {
        headers: { 'X-Admin-Token': 'wrong-secret' }
      });
      assert.equal(wrongRes.status, 401);

      // Valid server-to-server X-Admin-Token -> 200
      for (const reqSpec of protectedRequests) {
        const res = await fetch(`${srv.baseUrl}${reqSpec.path}`, {
          method: reqSpec.method,
          headers: {
            'X-Admin-Token': SECRET,
            ...(reqSpec.body ? { 'Content-Type': 'application/json' } : {})
          },
          body: reqSpec.body ? JSON.stringify(reqSpec.body) : undefined
        });
        assert.equal(res.status, 200, `Expected 200 with valid X-Admin-Token for ${reqSpec.method} ${reqSpec.path}`);
      }
    } finally {
      await srv.close();
    }
  });

  it('1c. TRUSTED_GATEWAY_HEADER and TRUSTED_PROXY_CIDRS enforce access boundary cleanly when configured', async () => {
    const srv = await startTestServer({
      nodeEnv: 'production',
      trustedProxyCidrs: '10.24.0.0/16',
      trustedGatewayHeader: 'X-IAP-Proxy-Auth=gateway-verified-token',
      resolveRemoteAddress: (req) => req.headers['x-test-peer'] || '10.24.5.12'
    });
    try {
      // Trusted CIDR + missing gateway header -> 401
      const noHeaderRes = await fetch(`${srv.baseUrl}/api/permits`, {
        headers: { 'x-test-peer': '10.24.5.12' }
      });
      assert.equal(noHeaderRes.status, 401);

      // Trusted CIDR + wrong gateway header -> 401
      const badHeaderRes = await fetch(`${srv.baseUrl}/api/permits`, {
        headers: { 'x-test-peer': '10.24.5.12', 'X-IAP-Proxy-Auth': 'forged' }
      });
      assert.equal(badHeaderRes.status, 401);

      // Untrusted peer IP even WITH right gateway header -> 401
      const spoofedPeerRes = await fetch(`${srv.baseUrl}/api/permits`, {
        headers: { 'x-test-peer': '203.0.113.22', 'X-IAP-Proxy-Auth': 'gateway-verified-token' }
      });
      assert.equal(spoofedPeerRes.status, 401);

      // Trusted CIDR + valid gateway header -> 200 regardless of client public IP in X-Forwarded-For
      const okRes = await fetch(`${srv.baseUrl}/api/permits`, {
        headers: { 'x-test-peer': '10.24.5.12', 'X-IAP-Proxy-Auth': 'gateway-verified-token', 'X-Forwarded-For': '198.51.100.10, 10.24.5.12' }
      });
      assert.equal(okRes.status, 200);
    } finally {
      await srv.close();
    }
  });

  it('1d. Production mode fails closed immediately at startup when SUPABASE_SERVICE_ROLE_KEY is missing', async () => {
    process.env.SKIP_SERVER_LISTEN = '1';
    const { createApiApp } = await import('../../server');
    const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      assert.throws(
        () => createApiApp({ nodeEnv: 'production', supabaseServiceRoleKey: '' }),
        /SUPABASE_SERVICE_ROLE_KEY must be configured when NODE_ENV=production/
      );
    } finally {
      if (prevKey !== undefined) {
        process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
      }
    }
  });

  it('1e. Vercel runtime blocks unauthenticated requests (401) across all admin routes and allows valid X-Admin-Token or gateway header', async () => {
    const SECRET = 'vercel-trusted-device-secret-777';
    let simulatedPeer = '76.76.21.21';
    const vercelProdSrv = await startTestServer({
      nodeEnv: 'production',
      adminSecret: SECRET,
      vercelRuntime: true,
      resolveRemoteAddress: () => simulatedPeer
    });
    try {
      const protectedEndpoints: Array<{ method: string; path: string; body?: any }> = [
        { method: 'GET', path: '/api/permits' },
        { method: 'POST', path: '/api/permits/update', body: { id: '1001', vrm: 'AB12CDE' } },
        { method: 'GET', path: '/api/vouchers' },
        { method: 'POST', path: '/api/vouchers/reset', body: {} },
        { method: 'GET', path: '/api/dispatched' },
        { method: 'POST', path: '/api/admin/dispatch/delete', body: { keys: ['1001'] } },
        { method: 'POST', path: '/api/admin/dispatch/clear', body: {} },
        { method: 'GET', path: '/api/blocklist' },
        { method: 'POST', path: '/api/blocklist', body: { items: [] } },
        { method: 'GET', path: '/api/emails/statuses' }
      ];

      // 1) Unauthenticated public requests on Vercel -> 401 (both public peer and internal 127.0.0.1/RFC1918 proxy hops)
      for (const peer of ['76.76.21.21', '127.0.0.1', '10.0.0.5']) {
        simulatedPeer = peer;
        for (const ep of protectedEndpoints) {
          const res = await fetch(`${vercelProdSrv.baseUrl}${ep.path}`, {
            method: ep.method,
            headers: {
              'X-Forwarded-For': '203.0.113.17',
              ...(ep.body ? { 'Content-Type': 'application/json' } : {})
            },
            body: ep.body ? JSON.stringify(ep.body) : undefined
          });
          assert.equal(res.status, 401, `Expected 401 on Vercel without auth (peer=${peer}) for ${ep.method} ${ep.path}`);
        }
      }

      // 2) Wrong X-Admin-Token on Vercel -> 401
      const wrongRes = await fetch(`${vercelProdSrv.baseUrl}/api/permits`, {
        headers: { 'X-Admin-Token': 'wrong-token' }
      });
      assert.equal(wrongRes.status, 401);

      // 3) Valid X-Admin-Token on Vercel -> 200 regardless of home or hospital public IP
      for (const ep of protectedEndpoints) {
        const res = await fetch(`${vercelProdSrv.baseUrl}${ep.path}`, {
          method: ep.method,
          headers: {
            'X-Admin-Token': SECRET,
            'X-Forwarded-For': '198.51.100.42',
            ...(ep.body ? { 'Content-Type': 'application/json' } : {})
          },
          body: ep.body ? JSON.stringify(ep.body) : undefined
        });
        assert.equal(res.status, 200, `Expected 200 on Vercel with valid X-Admin-Token for ${ep.method} ${ep.path}`);
      }
    } finally {
      await vercelProdSrv.close();
    }

    // 4) Vercel runtime WITH configured TRUSTED_GATEWAY_HEADER allows verified gateway requests (200) and rejects missing/wrong ones (401)
    const vercelGatewaySrv = await startTestServer({
      nodeEnv: 'production',
      vercelRuntime: true,
      trustedGatewayHeader: 'X-IAP-Proxy-Auth=vercel-gateway-ok',
      resolveRemoteAddress: () => '76.76.21.21'
    });
    try {
      const noGw = await fetch(`${vercelGatewaySrv.baseUrl}/api/permits`);
      assert.equal(noGw.status, 401);

      const okGw = await fetch(`${vercelGatewaySrv.baseUrl}/api/permits`, {
        headers: { 'X-IAP-Proxy-Auth': 'vercel-gateway-ok', 'X-Forwarded-For': '203.0.113.17' }
      });
      assert.equal(okGw.status, 200);
    } finally {
      await vercelGatewaySrv.close();
    }
  });

  it('1f. Option B client enrollment stores #admin_token in localStorage, strips hash via replaceState, and auto-attaches X-Admin-Token in apiFetch', async () => {
    const SECRET = 'device-bookmark-token-abc123';
    const srv = await startTestServer({
      nodeEnv: 'production',
      adminSecret: SECRET,
      vercelRuntime: true,
      resolveRemoteAddress: () => '76.76.21.21'
    });

    const prevWindow = (globalThis as any).window;
    const prevFetch = globalThis.fetch;
    const storageMap = new Map<string, string>();
    const replaceCalls: Array<{ url: string }> = [];

    const mockWindow: any = {
      location: {
        origin: srv.baseUrl,
        pathname: '/admin',
        search: '?site=whipps',
        hash: `#admin_token=${SECRET}&tab=dispatch`
      },
      history: {
        state: { idx: 0 },
        replaceState: (_state: any, _title: string, url: string) => {
          replaceCalls.push({ url });
          const hashIdx = url.indexOf('#');
          mockWindow.location.hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
        }
      },
      localStorage: {
        getItem: (k: string) => storageMap.get(k) ?? null,
        setItem: (k: string, v: string) => { storageMap.set(k, String(v)); },
        removeItem: (k: string) => { storageMap.delete(k); }
      }
    };

    try {
      (globalThis as any).window = mockWindow;
      const { ADMIN_TOKEN_STORAGE_KEY, enrollAdminTokenFromHash, getStoredAdminToken, apiFetch } = await import('../lib/apiClient');

      // 1) Enroll token from #admin_token hash
      const enrolled = enrollAdminTokenFromHash();
      assert.equal(enrolled, SECRET);
      assert.equal(storageMap.get(ADMIN_TOKEN_STORAGE_KEY), SECRET);
      assert.equal(getStoredAdminToken(), SECRET);
      assert.equal(replaceCalls.length, 1);
      assert.equal(replaceCalls[0].url, '/admin?site=whipps#tab=dispatch');
      assert.equal(mockWindow.location.hash.includes('admin_token'), false);

      // 2) apiFetch attaches X-Admin-Token automatically for /api/* requests and succeeds (200) against locked Vercel server
      let capturedCrossOriginHeader: string | null = null;
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const urlStr = typeof input === 'string' ? input : String(input);
        if (urlStr.startsWith('/api/')) {
          return prevFetch(`${srv.baseUrl}${urlStr}`, init);
        }
        const headers = new Headers(init?.headers || undefined);
        capturedCrossOriginHeader = headers.get('X-Admin-Token');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as any;

      const permitsRes = await apiFetch('/api/permits');
      assert.equal(permitsRes.status, 200, 'apiFetch must automatically supply stored X-Admin-Token on /api/* calls');

      // 3) Cross-origin external URLs never receive X-Admin-Token
      await apiFetch('https://third-party.example.com/api/data');
      assert.equal(capturedCrossOriginHeader, null, 'Must never send X-Admin-Token to external third-party origins');
    } finally {
      globalThis.fetch = prevFetch;
      if (prevWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = prevWindow;
      }
      await srv.close();
    }
  });

  // =========================================================================
  // 2. Email Prepared vs Sent Lifecycle & Strict Voucher Validation
  // =========================================================================
  it('2. /api/emails/resend records PREPARED status, rejects empty/placeholder codes with 400, and transitions only on confirm/revert', async () => {
    const srv = await startTestServer();
    try {
      const invalidCodes = ['', '   ', '-', 'CANCELLED', 'PENDING', 'UNDEFINED', 'null'];
      for (const badCode of invalidCodes) {
        const badRes = await fetch(`${srv.baseUrl}/api/emails/resend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recordKey: '1001', vrm: 'AB12CDE', requestedCode: badCode })
        });
        assert.equal(badRes.status, 400, `Expected 400 for requestedCode="${badCode}"`);
      }

      const prepRes = await fetch(`${srv.baseUrl}/api/emails/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordKey: '1001', vrm: 'AB12CDE', requestedCode: 'REAL_999' })
      });
      assert.equal(prepRes.status, 200);
      const prepData = await prepRes.json();
      assert.equal(prepData.status, 'PREPARED');
      assert.equal(prepData.voucherCode, 'REAL_999');
      assert.ok(prepData.trackingId);

      // Before confirmation, status is PREPARED and recordKey/vrm must NOT show SENT
      const statusesBefore = await (await fetch(`${srv.baseUrl}/api/emails/statuses`)).json();
      assert.equal(statusesBefore.statuses[prepData.trackingId].status, 'PREPARED');
      assert.equal(statusesBefore.statuses['1001'], undefined);

      // Confirm -> SENT
      const confirmRes = await fetch(`${srv.baseUrl}/api/emails/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingId: prepData.trackingId })
      });
      assert.equal(confirmRes.status, 200);
      const statusesAfterConfirm = await (await fetch(`${srv.baseUrl}/api/emails/statuses`)).json();
      assert.equal(statusesAfterConfirm.statuses['1001'].status, 'SENT');

      // Prepare another one and revert -> removed cleanly
      const prep2 = await (await fetch(`${srv.baseUrl}/api/emails/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordKey: '1002', vrm: 'XY99ZZZ', requestedCode: 'REAL_888' })
      })).json();
      assert.equal(prep2.status, 'PREPARED');

      const revertRes = await fetch(`${srv.baseUrl}/api/emails/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingId: prep2.trackingId })
      });
      assert.equal(revertRes.status, 200);
      const statusesAfterRevert = await (await fetch(`${srv.baseUrl}/api/emails/statuses`)).json();
      assert.equal(statusesAfterRevert.statuses[prep2.trackingId], undefined);
      assert.equal(statusesAfterRevert.statuses['1002'], undefined);
    } finally {
      await srv.close();
    }
  });

  // =========================================================================
  // 3. Blocklist Pre-Check & Full Rollback (Including Failed sendOne)
  // =========================================================================
  it('3a. executeReplacementResendTransaction aborts with zero mutations if VRM is blocked before /api/emails/resend', async () => {
    const blockedRecord: CsvPermitRecord = {
      id: '1311',
      formId: '1311',
      vrm: 'AU67 HCZ',
      driverName: 'Sarah Connor',
      email: 's.connor@example.com',
      hospital: 'Whipps Cross',
      ward: 'Emergency Care',
      dateRequired: '2026-10-01',
      voucherCode: 'ORIG_111',
      replacementCode: 'NEW_222',
      status: 'SENT',
      isDispatched: true
    };

    let resendApiCalled = false;
    let updatePermitCalled = false;
    let markDispatchedCalled = false;
    let sendOneCalled = false;
    let vouchersState: ParsedVoucherData[] = [{ code: 'NEW_222', status: 'active', isUsed: false }];
    let rejectedErr: unknown = null;
    const toasts: Array<{ msg: string; type?: string }> = [];

    const ok = await executeReplacementResendTransaction(
      blockedRecord,
      {
        writePromise: null,
        resolveBlob: () => {},
        rejectBlob: (err) => { rejectedErr = err; }
      },
      {
        getFormData: () => ({
          id: '1311',
          formId: '1311',
          title: 'Concessions',
          site: 'Whipps Cross',
          name: 'Sarah Connor',
          vrm: 'AU67 HCZ',
          validFrom: '2026-10-01',
          validTo: '2026-10-07',
          ward: 'Emergency Care',
          qrOverride: '',
          voucherCodesText: 'NEW_222',
          replacementCode: 'NEW_222',
          phone: '',
          email: 's.connor@example.com',
          todayDate: '2026-10-01'
        }),
        getDatabase: () => [blockedRecord],
        getVouchersDatabase: () => vouchersState,
        getCustomVouchers: () => ({ '1311': 'ORIG_111' }),
        getEmailTracking: () => ({}),
        applyEmailTracking: () => {},
        applyVouchersDatabase: (n) => { vouchersState = n; },
        applyDatabase: () => {},
        applyCustomVouchers: () => {},
        applyFormData: () => {},
        storageMode: 'cloud',
        isSupabaseConfigured: () => true,
        checkVrmBlocked: async () => true,
        resendEmailApi: async () => { resendApiCalled = true; return { ok: true, trackingId: 'trk_should_never_happen' }; },
        updatePermitInSupabase: async () => { updatePermitCalled = true; return true; },
        markAsDispatched: async () => { markDispatchedCalled = true; return true; },
        selectRecord: () => {},
        sendOne: async () => { sendOneCalled = true; return true; },
        showToast: (msg, type) => { toasts.push({ msg, type }); }
      }
    );

    assert.equal(ok, false);
    assert.equal(resendApiCalled, false, '/api/emails/resend must NOT run when VRM is blocked');
    assert.equal(updatePermitCalled, false, 'Supabase permit update must NOT run when VRM is blocked');
    assert.equal(markDispatchedCalled, false, 'markAsDispatched must NOT run when VRM is blocked');
    assert.equal(sendOneCalled, false, 'sendOne must NOT run when VRM is blocked');
    assert.equal(vouchersState[0].isUsed, false, 'Voucher must NOT be mutated when VRM is blocked');
    assert.ok(rejectedErr instanceof Error);
    assert.equal(toasts.some(t => t.type === 'error'), true);
  });

  it('3b. executeReplacementResendTransaction performs FULL state, localStorage, cloud permit, dispatch, and email rollback when sendOne() fails or throws', async () => {
    for (const mode of ['returns_false', 'throws'] as const) {
      const initialRecord: CsvPermitRecord = {
        id: '1003',
        formId: '1003',
        vrm: 'LM44 ABC',
        driverName: 'Claire Lee',
        email: 'claire@example.com',
        hospital: 'Whipps Cross',
        ward: 'Ward 8',
        dateRequired: '2026-10-03',
        voucherCode: 'ORIG_777',
        prePaidCode: 'ORIG_777',
        replacementCode: 'REP_888',
        originalVoucherCode: 'ORIG_777',
        isResend: true,
        emailType: 'RESEND_CONCESSION',
        emailTemplate: 'replacement',
        status: 'SENT',
        isDispatched: false
      };

      const initialDispatchSnap: DispatchStateSnapshot = {
        dispatchedKeys: ['9999'],
        dispatchDates: { '9999': '2026-10-01' },
        dispatchBy: { '9999': 'Admin' },
        unsentKeys: []
      };

      const initialPermitJson = JSON.stringify([initialRecord]);
      const initialVouchersJson = JSON.stringify([{ code: 'REP_888', status: 'active', isUsed: false }]);
      const initialCustomJson = JSON.stringify({ '1003': 'ORIG_777' });
      const initialTrackingJson = JSON.stringify({ '1003': { status: 'SENT', trackingId: 'trk_prior' } });
      const initialDispKeysJson = JSON.stringify(initialDispatchSnap.dispatchedKeys);
      const initialDispDatesJson = JSON.stringify(initialDispatchSnap.dispatchDates);
      const initialDispByJson = JSON.stringify(initialDispatchSnap.dispatchBy);

      const memStore = new Map<string, string>([
        ['concessions_permit_db', initialPermitJson],
        ['concessions_vouchers_db', initialVouchersJson],
        ['concessions_custom_vouchers', initialCustomJson],
        ['concessions_email_tracking', initialTrackingJson],
        ['concessions_dispatched_keys', initialDispKeysJson],
        ['concessions_dispatch_dates', initialDispDatesJson],
        ['concessions_dispatch_by', initialDispByJson]
      ]);

      let dbState: CsvPermitRecord[] = [initialRecord];
      let vouchersState: ParsedVoucherData[] = [{ code: 'REP_888', status: 'active', isUsed: false }];
      let customState: Record<string, string> = { '1003': 'ORIG_777' };
      let trackingState: Record<string, EmailTrackingInfo> = { '1003': { status: 'SENT', trackingId: 'trk_prior' } };
      let dispatchSnap: DispatchStateSnapshot = {
        dispatchedKeys: [...initialDispatchSnap.dispatchedKeys],
        dispatchDates: { ...initialDispatchSnap.dispatchDates },
        dispatchBy: { ...initialDispatchSnap.dispatchBy },
        unsentKeys: [...initialDispatchSnap.unsentKeys]
      };
      let formState: PermitData = {
        id: '1003',
        formId: '1003',
        title: 'Concessions',
        site: 'Whipps Cross',
        name: 'Claire Lee',
        vrm: 'LM44 ABC',
        validFrom: '2026-10-03',
        validTo: '2026-10-09',
        ward: 'Ward 8',
        qrOverride: '',
        voucherCodesText: 'REP_888',
        replacementCode: 'REP_888',
        phone: '',
        email: 'claire@example.com',
        todayDate: '2026-10-03'
      };

      const updatedPermitCalls: CsvPermitRecord[] = [];
      const revertedTrackingIds: string[] = [];
      let confirmCalled = false;
      let dispatchRollbackCalled = false;
      let rejectedErr: unknown = null;
      const toasts: Array<{ msg: string; type?: string }> = [];

      const ok = await executeReplacementResendTransaction(
        initialRecord,
        {
          writePromise: null,
          resolveBlob: () => {},
          rejectBlob: (err) => { rejectedErr = err; }
        },
        {
          getFormData: () => formState,
          getDatabase: () => dbState,
          getVouchersDatabase: () => vouchersState,
          getCustomVouchers: () => customState,
          getEmailTracking: () => trackingState,
          applyEmailTracking: (n) => { trackingState = n; },
          applyVouchersDatabase: (n) => { vouchersState = n; },
          applyDatabase: (n) => { dbState = n; },
          applyCustomVouchers: (n) => { customState = n; },
          applyFormData: (n) => { formState = n; },
          storageMode: 'cloud',
          isSupabaseConfigured: () => true,
          checkVrmBlocked: async () => false,
          resendEmailApi: async () => ({ ok: true, status: 200, voucherCode: 'REP_888', trackingId: 'trk_prepared_123' }),
          confirmEmailApi: async () => { confirmCalled = true; return true; },
          revertEmailApi: async (id) => { revertedTrackingIds.push(id); return true; },
          updatePermitInSupabase: async (rec) => {
            updatedPermitCalls.push(rec);
            return true;
          },
          isRecordCurrentlyDispatched: () => false,
          getDispatchSnapshot: () => dispatchSnap,
          applyDispatchSnapshot: (snap) => { dispatchSnap = snap; },
          markAsDispatched: async () => {
            dispatchSnap = {
              dispatchedKeys: [...dispatchSnap.dispatchedKeys, '1003', 'LM44ABC'],
              dispatchDates: { ...dispatchSnap.dispatchDates, '1003': '2026-10-03' },
              dispatchBy: { ...dispatchSnap.dispatchBy, '1003': 'System User' },
              unsentKeys: []
            };
            memStore.set('concessions_dispatched_keys', JSON.stringify(dispatchSnap.dispatchedKeys));
            return true;
          },
          rollbackDispatch: async () => {
            dispatchRollbackCalled = true;
            return true;
          },
          selectRecord: () => {},
          sendOne: async () => {
            if (mode === 'throws') {
              throw new Error('Outlook popup blocked');
            }
            return false;
          },
          showToast: (msg, type) => { toasts.push({ msg, type }); },
          storage: {
            getItem: (k) => memStore.get(k) ?? null,
            setItem: (k, v) => { memStore.set(k, v); },
            removeItem: (k) => { memStore.delete(k); }
          }
        }
      );

      assert.equal(ok, false, `Expected failure rollback when sendOne ${mode}`);
      assert.equal(confirmCalled, false, 'confirmEmailApi must NOT be called if sendOne failed');
      assert.deepEqual(revertedTrackingIds, ['trk_prepared_123'], 'Prepared tracking record must be reverted');
      assert.equal(dispatchRollbackCalled, true, 'Cloud dispatch row must be rolled back');
      assert.ok(rejectedErr instanceof Error);

      // Verify full state & localStorage rollback
      assert.equal(dbState[0].voucherCode, 'ORIG_777');
      assert.equal(dbState[0].replacementCode, 'REP_888');
      assert.equal(vouchersState[0].isUsed, false);
      assert.equal(customState['1003'], 'ORIG_777');
      assert.equal(trackingState['1003'].trackingId, 'trk_prior');
      assert.equal(formState.replacementCode, 'REP_888');
      assert.deepEqual(dispatchSnap, initialDispatchSnap);

      assert.equal(memStore.get('concessions_permit_db'), initialPermitJson);
      assert.equal(memStore.get('concessions_vouchers_db'), initialVouchersJson);
      assert.equal(memStore.get('concessions_custom_vouchers'), initialCustomJson);
      assert.equal(memStore.get('concessions_email_tracking'), initialTrackingJson);
      assert.equal(memStore.get('concessions_dispatched_keys'), initialDispKeysJson);

      assert.equal(updatedPermitCalls.length, 2);
      assert.equal(updatedPermitCalls[1].voucherCode, 'ORIG_777');
      assert.equal(updatedPermitCalls[1].replacementCode, 'REP_888');
      assert.equal(toasts.some(t => t.type === 'error'), true);
    }
  });

  // =========================================================================
  // 4. Atomic Transactional Blocklist Sync & Surface Hydration Failures
  // =========================================================================
  it('4a. AU67 HCZ stays actively blocked while expired block entries are enforced cleanly', () => {
    safeLocalStorage.removeItem(BLOCKLIST_STORAGE_KEY);
    const seed = getBlocklist();
    assert.ok(seed.some((i) => i.vrm === 'AU67 HCZ'));
    assert.equal(isVrmSilentBlockedSync('AU67 HCZ', '2026-11-23'), true);

    const mixed: BlocklistItem[] = [
      ...seed,
      { id: 'blk_exp', vrm: 'EXP1 234', expiryDate: '2025-05-17', reason: 'Old block' },
      { id: 'blk_fut', vrm: 'FUT9 999', expiryDate: '2028-12-31', reason: 'Future block' }
    ];
    safeLocalStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify(mixed));

    assert.equal(isVrmSilentBlockedSync('EXP1 234', '2026-11-23'), false);
    assert.equal(isVrmSilentBlockedSync('FUT9 999', '2026-11-23'), true);
  });

  it('4b. POST /api/blocklist executes atomically via replace_blocklist RPC so failed upserts preserve existing rows, and hydration failures set stale warning state', async () => {
    const initialRows = [
      { id: 'blk_seed_1', form_id: '1311', vrm: 'AU67 HCZ', reason: 'Duplicate permit abuse' },
      { id: 'blk_existing_2', form_id: '2000', vrm: 'KEEP 111', reason: 'Existing rule' }
    ];

    // 1) Atomic replacement succeeds and removes removed entries
    const srv = await startTestServer({
      mockOpts: { initialBlocklistRows: initialRows }
    });
    const prevFetch = globalThis.fetch;
    try {
      const postRes = await prevFetch(`${srv.baseUrl}/api/blocklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { id: 'blk_seed_1', vrm: 'AU67 HCZ', reason: 'Duplicate permit abuse' }
          ]
        })
      });
      assert.equal(postRes.status, 200);
      assert.equal(srv.mockSb.rpcCalls.some(c => c.fn === 'replace_blocklist'), true);
      assert.equal(srv.mockSb.getBlocklistRows().some((r) => r.vrm === 'KEEP 111'), false);

      // Hydrate overrides stale localStorage and clears stale sync state
      globalThis.fetch = ((input: any, init?: any) => {
        const url = typeof input === 'string' && input.startsWith('/') ? `${srv.baseUrl}${input}` : input;
        return prevFetch(url, init);
      }) as typeof fetch;

      safeLocalStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([
        { id: 'blk_seed_1', vrm: 'AU67 HCZ', reason: 'Seed' },
        { id: 'blk_stale', vrm: 'STL0 000', reason: 'Stale local' }
      ]));

      const hydrated = await hydrateBlocklistFromServer();
      assert.ok(hydrated);
      assert.equal(hydrated!.some((i) => i.vrm === 'STL0 000'), false);
      assert.equal(getBlocklistSyncStatus().hydrated, true);
      assert.equal(getBlocklistSyncStatus().isStale, false);
      assert.equal(getBlocklistSyncStatus().error, null);
    } finally {
      globalThis.fetch = prevFetch;
      await srv.close();
    }

    // 2) Failed upsert inside atomic RPC MUST leave prior entries completely intact + surface hydration failure
    const failSrv = await startTestServer({
      mockOpts: {
        initialBlocklistRows: initialRows,
        failBlocklistUpsert: true,
        failBlocklistSelect: true
      }
    });
    try {
      globalThis.fetch = ((input: any, init?: any) => {
        const url = typeof input === 'string' && input.startsWith('/') ? `${failSrv.baseUrl}${input}` : input;
        return prevFetch(url, init);
      }) as typeof fetch;

      safeLocalStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([
        { id: 'blk_seed_1', vrm: 'AU67 HCZ', reason: 'Seed' }
      ]));

      await assert.rejects(
        () => saveBlocklist([
          { id: 'blk_seed_1', vrm: 'AU67 HCZ', reason: 'Seed' },
          { id: 'blk_new', vrm: 'NEW7 777', reason: 'Should fail' }
        ]),
        /Supabase upsert failure/
      );

      // Existing Supabase rows (including KEEP 111 that was omitted from the failed payload) remain untouched!
      assert.equal(
        failSrv.mockSb.getBlocklistRows().some((r) => r.vrm === 'KEEP 111'),
        true,
        'Atomic transaction failure must preserve previously stored blocklist entries'
      );
      assert.equal(getBlocklist().some((i) => i.vrm === 'NEW7 777'), false);

      // Failed hydration surfaces warning/stale state instead of failing silently
      const failedHydrate = await hydrateBlocklistFromServer();
      assert.equal(failedHydrate, null);
      const syncStatus = getBlocklistSyncStatus();
      assert.equal(syncStatus.isStale, true);
      assert.equal(syncStatus.hydrated, false);
      assert.ok(syncStatus.error && syncStatus.error.includes('Supabase select failure'));
    } finally {
      globalThis.fetch = prevFetch;
      await failSrv.close();
    }
  });

  it('4c. Missing public.blocklist table or replace_blocklist RPC returns HTTP 503 and surfaces genuine unsynchronised warning state while preserving local fallback validation', async () => {
    // Start with a healthy server to guarantee clean sync state regardless of prior test order,
    // then test transition into missing public.blocklist / replace_blocklist failure.
    const healthySrv = await startTestServer();
    const schemaMissingSrv = await startTestServer({
      mockOpts: { missingBlocklistSchema: true }
    });
    const prevFetch = globalThis.fetch;
    const prevWindow = (globalThis as any).window;
    const dispatchedEvents: Array<{ type: string; detail: any }> = [];

    (globalThis as any).window = {
      dispatchEvent: (ev: any) => {
        dispatchedEvents.push({ type: ev?.type, detail: ev?.detail });
        return true;
      }
    };

    try {
      // Reset module sync status cleanly via healthy server
      globalThis.fetch = ((input: any, init?: any) => {
        const url = typeof input === 'string' && input.startsWith('/') ? `${healthySrv.baseUrl}${input}` : input;
        return prevFetch(url, init);
      }) as typeof fetch;
      await hydrateBlocklistFromServer();
      dispatchedEvents.length = 0;

      // Switch to server where Supabase is missing public.blocklist and replace_blocklist
      globalThis.fetch = ((input: any, init?: any) => {
        const url = typeof input === 'string' && input.startsWith('/') ? `${schemaMissingSrv.baseUrl}${input}` : input;
        return prevFetch(url, init);
      }) as typeof fetch;

      // Seed cached local browser blocklist rules (including permanent AU67 HCZ, active local rule, and expired rule)
      safeLocalStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([
        { id: 'blk_seed_1', vrm: 'AU67 HCZ', reason: 'Seed' },
        { id: 'blk_local_1', vrm: 'LOC9 999', reason: 'Local block rule', expiryDate: '2099-12-31' },
        { id: 'blk_exp_1', vrm: 'EXP0 111', reason: 'Expired rule', expiryDate: '2024-01-01' }
      ]));

      // 1) GET /api/blocklist returns explicit HTTP 503 (never 200 fallbackToLocal)
      const getRes = await prevFetch(`${schemaMissingSrv.baseUrl}/api/blocklist`);
      assert.equal(getRes.status, 503);
      const getJson = await getRes.json();
      assert.equal(getJson.fallbackToLocal, undefined);
      assert.ok(String(getJson.error || '').includes('public.blocklist'));

      // 2) hydrateBlocklistFromServer surfaces genuine unsynchronised warning state (isStale: true, non-null error)
      const hydrated = await hydrateBlocklistFromServer();
      assert.equal(hydrated, null);
      const hydrateStatus = getBlocklistSyncStatus();
      assert.equal(hydrateStatus.isStale, true);
      assert.equal(hydrateStatus.hydrated, false);
      assert.ok(hydrateStatus.error && hydrateStatus.error.includes('public.blocklist'));
      assert.equal(dispatchedEvents.some((e) => e.type === 'blocklist_sync_error'), true);
      assert.equal(
        dispatchedEvents.some((e) => e.type === 'app-toast' && String(e.detail?.message || '').includes('Central blocklist sync failed')),
        true
      );

      // 3) POST /api/blocklist returns explicit HTTP 503 and saveBlocklist rejects while keeping isStale: true & non-null error
      const postRes = await prevFetch(`${schemaMissingSrv.baseUrl}/api/blocklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { id: 'blk_seed_1', vrm: 'AU67 HCZ', reason: 'Seed' },
            { id: 'blk_local_2', vrm: 'BLK5 555', reason: 'Should fail central sync' }
          ]
        })
      });
      assert.equal(postRes.status, 503);
      const postJson = await postRes.json();
      assert.equal(postJson.fallbackToLocal, undefined);
      assert.ok(String(postJson.error || '').includes('replace_blocklist'));

      await assert.rejects(
        () => saveBlocklist([
          { id: 'blk_seed_1', vrm: 'AU67 HCZ', reason: 'Seed' },
          { id: 'blk_local_2', vrm: 'BLK5 555', reason: 'Should fail central sync' }
        ]),
        /replace_blocklist/
      );
      const postSaveStatus = getBlocklistSyncStatus();
      assert.equal(postSaveStatus.isStale, true);
      assert.ok(postSaveStatus.error && postSaveStatus.error.includes('replace_blocklist'));

      // 4) Cached local rules remain intact (unsaved BLK5 555 not persisted) and local validation still enforces AU67 HCZ, LOC9 999, and expiry checks
      assert.equal(getBlocklist().some((i) => i.vrm === 'BLK5 555'), false);
      assert.equal(await isVrmSilentBlocked('LOC9 999', '2026-11-25'), true);
      assert.equal(await isVrmSilentBlocked('EXP0 111', '2026-11-25'), false);
      assert.equal(await isVrmSilentBlocked('AU67 HCZ', '2026-11-25'), true);
      assert.equal(await isVrmSilentBlocked('OK12 ABC', '2026-11-25'), false);
    } finally {
      globalThis.fetch = prevFetch;
      if (prevWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = prevWindow;
      }
      await healthySrv.close();
      await schemaMissingSrv.close();
    }
  });

  it('1g. Vercel serverless entry point api/index.ts and vercel.json route all /api/* endpoints without 404', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const vercelConfigPath = path.join(process.cwd(), 'vercel.json');
    assert.equal(fs.existsSync(vercelConfigPath), true, 'vercel.json must exist at project root');
    const vercelConfig = JSON.parse(fs.readFileSync(vercelConfigPath, 'utf8'));
    assert.equal(Array.isArray(vercelConfig.rewrites), true, 'vercel.json must define rewrites');
    assert.deepEqual(vercelConfig.rewrites[0], {
      source: '/api/(.*)',
      destination: '/api/index.ts'
    });
    assert.equal(
      vercelConfig.rewrites.some((r: any) => r.destination === '/index.html'),
      true,
      'vercel.json must include SPA fallback to /index.html'
    );

    process.env.SKIP_SERVER_LISTEN = '1';
    const vercelEntry = await import('../../api/index');
    const handler = vercelEntry.default;
    assert.equal(typeof handler, 'function', 'api/index.ts must default-export the Express app handler');

    const srv = http.createServer(handler);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const healthRes = await fetch(`${baseUrl}/api/health`);
      assert.equal(healthRes.status, 200);

      const cfgRes = await fetch(`${baseUrl}/api/config`);
      assert.equal(cfgRes.status, 200);

      for (const apiPath of ['/api/dispatched', '/api/permits', '/api/vouchers', '/api/blocklist', '/api/emails/statuses']) {
        const res = await fetch(`${baseUrl}${apiPath}`);
        assert.notEqual(res.status, 404, `Vercel serverless Express handler must resolve ${apiPath} without 404`);
      }
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

