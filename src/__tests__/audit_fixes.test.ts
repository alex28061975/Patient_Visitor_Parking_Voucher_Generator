import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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
import {
  setSupabaseClientOverride,
  isSupabaseConfigured,
  fetchPermitsFromSupabase,
  updatePermitInSupabase,
  fetchVouchersFromSupabase,
  fetchDispatchedFromSupabase,
  syncDispatchedToSupabase
} from '../lib/supabase';
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

  const buildResult = (res: any) => {
    const p = Promise.resolve(res) as any;
    p.range = () => buildResult(res);
    p.order = () => buildResult(res);
    p.gte = () => buildResult(res);
    p.eq = () => buildResult(res);
    p.neq = () => buildResult(res);
    p.in = () => buildResult(res);
    p.limit = () => buildResult(res);
    return p;
  };

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
        if (options?.failBlocklistUpsert) {
          return { data: null, error: { message: 'Supabase upsert failure' } };
        }
        const incoming = Array.isArray(args?.entries) ? args.entries : [];
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
          },
          upsert: async (rows: any[]) => {
            if (options?.missingBlocklistSchema) {
              return {
                data: null,
                error: {
                  code: 'PGRST205',
                  message: "Could not find the table 'public.blocklist' in the schema cache"
                }
              };
            }
            if (options?.failBlocklistUpsert) {
              return { data: null, error: { message: 'Supabase upsert failure' } };
            }
            blocklistRows = Array.isArray(rows) ? rows.map((r) => ({ ...r })) : [];
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
            return buildResult({
              data: [{ id: '1001', hospital: 'Whipps Cross', ward: 'Acorn', date_required: '2099-10-01', vrm: 'AB12CDE', driver_name: 'Jane' }],
              error: null
            });
          },
          update: () => ({
            in: async () => ({ error: null, count: 0 }),
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
          select: () => buildResult({
            data: [{ code: 'VOUCH123', valid_from: '2026-12-01', valid_to: '2026-12-07', status: 'active', is_used: false }],
            error: null
          }),
          upsert: async () => ({ error: null }),
          delete: () => ({
            neq: async () => ({ error: null })
          })
        };
      }

      if (table === 'dispatched_history') {
        return {
          select: () => buildResult({
            data: [{ key: '1001', dispatch_date: '2026-11-25', dispatch_by: 'System User' }],
            error: null
          }),
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

describe('Direct Supabase Client & Core Invariants Test Suite', () => {

  // =========================================================================
  // 1. Direct Browser-to-Supabase Integration & Zero Proxy Layer
  // =========================================================================
  it('1a. Direct Supabase client reads and writes permits, vouchers, and dispatched history without /api proxy calls', async () => {
    const mockSb = createMockSupabase();
    setSupabaseClientOverride(mockSb.client);
    try {
      assert.equal(isSupabaseConfigured(), true);

      const permits = await fetchPermitsFromSupabase();
      assert.ok(Array.isArray(permits));
      assert.equal(permits!.length, 1);
      assert.equal(permits![0].vrm, 'AB12CDE');

      const updateOk = await updatePermitInSupabase({
        id: '1001',
        formId: '1001',
        hospital: 'Whipps Cross',
        ward: 'Acorn',
        dateRequired: '2099-10-01',
        vrm: 'AB12CDE',
        driverName: 'Jane'
      });
      assert.equal(updateOk, true);

      const vouchers = await fetchVouchersFromSupabase();
      assert.ok(Array.isArray(vouchers));
      assert.equal(vouchers![0].code, 'VOUCH123');

      const dispatched = await fetchDispatchedFromSupabase();
      assert.ok(dispatched);
      assert.deepEqual(dispatched!.dispatchedKeys, ['1001']);

      const syncDisp = await syncDispatchedToSupabase('1001', '2026-11-25', 'Tester', 'AB12CDE', 'jane@example.com');
      assert.equal(syncDisp.success, true);
    } finally {
      setSupabaseClientOverride(null);
    }
  });

  it('1b. Obsolete server proxy / token enrollment / service-role dependencies are removed', () => {
    const rootDir = process.cwd();
    assert.equal(fs.existsSync(path.join(rootDir, 'api', 'index.ts')), false, 'api/index.ts must be removed');
    assert.equal(fs.existsSync(path.join(rootDir, 'src', 'lib', 'apiClient.ts')), false, 'src/lib/apiClient.ts must be removed');

    const vercelConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'vercel.json'), 'utf8'));
    assert.equal(
      vercelConfig.rewrites.some((r: any) => String(r.source || '').includes('/api') || String(r.destination || '').includes('/api')),
      false,
      'vercel.json must not contain /api routing rules'
    );
    assert.equal(
      vercelConfig.rewrites.some((r: any) => r.destination === '/index.html'),
      true,
      'vercel.json must retain Vite SPA /index.html fallback'
    );

    const serverSource = fs.readFileSync(path.join(rootDir, 'server.ts'), 'utf8');
    assert.equal(serverSource.includes('ADMIN_API_SECRET'), false);
    assert.equal(serverSource.includes('SUPABASE_SERVICE_ROLE_KEY'), false);
    assert.equal(serverSource.includes('X-Admin-Token'), false);
  });

  // =========================================================================
  // 2. Blocklist Pre-Check & Full Rollback (Including Failed sendOne)
  // =========================================================================
  it('2a. executeReplacementResendTransaction aborts with zero mutations if VRM is blocked', async () => {
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
    assert.equal(resendApiCalled, false);
    assert.equal(updatePermitCalled, false);
    assert.equal(markDispatchedCalled, false);
    assert.equal(sendOneCalled, false);
    assert.equal(vouchersState[0].isUsed, false);
    assert.ok(rejectedErr instanceof Error);
    assert.equal(toasts.some(t => t.type === 'error'), true);
  });

  it('2b. executeReplacementResendTransaction performs FULL state, localStorage, cloud permit, dispatch, and email rollback when sendOne() fails or throws', async () => {
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

      assert.equal(ok, false);
      assert.equal(confirmCalled, false);
      assert.deepEqual(revertedTrackingIds, ['trk_prepared_123']);
      assert.equal(dispatchRollbackCalled, true);
      assert.ok(rejectedErr instanceof Error);

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
  // 3. Direct Supabase Blocklist Sync & Graceful Local Fallback
  // =========================================================================
  it('3a. AU67 HCZ stays actively blocked while expired block entries are enforced cleanly', () => {
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

  it('3b. Direct Supabase blocklist sync executes atomically via replace_blocklist RPC and surfaces real query failures', async () => {
    const initialRows = [
      { id: 'blk_seed_1', form_id: '1311', vrm: 'AU67 HCZ', reason: 'Duplicate permit abuse' },
      { id: 'blk_existing_2', form_id: '2000', vrm: 'KEEP 111', reason: 'Existing rule' }
    ];

    const healthySb = createMockSupabase({ initialBlocklistRows: initialRows });
    setSupabaseClientOverride(healthySb.client);
    try {
      await saveBlocklist([
        { id: 'blk_seed_1', vrm: 'AU67 HCZ', reason: 'Duplicate permit abuse' }
      ]);
      assert.equal(healthySb.rpcCalls.some(c => c.fn === 'replace_blocklist'), true);
      assert.equal(healthySb.getBlocklistRows().some((r) => r.vrm === 'KEEP 111'), false);

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
      setSupabaseClientOverride(null);
    }

    const failingSb = createMockSupabase({
      initialBlocklistRows: initialRows,
      failBlocklistUpsert: true,
      failBlocklistSelect: true
    });
    setSupabaseClientOverride(failingSb.client);
    try {
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

      assert.equal(failingSb.getBlocklistRows().some((r) => r.vrm === 'KEEP 111'), true);
      assert.equal(getBlocklist().some((i) => i.vrm === 'NEW7 777'), false);

      const failedHydrate = await hydrateBlocklistFromServer();
      assert.equal(failedHydrate, null);
      const syncStatus = getBlocklistSyncStatus();
      assert.equal(syncStatus.isStale, true);
      assert.equal(syncStatus.hydrated, false);
      assert.ok(syncStatus.error && syncStatus.error.includes('Supabase select failure'));
    } finally {
      setSupabaseClientOverride(null);
    }
  });

  it('3c. Missing public.blocklist table falls back gracefully to local browser storage without error banners', async () => {
    const schemaMissingSb = createMockSupabase({ missingBlocklistSchema: true });
    setSupabaseClientOverride(schemaMissingSb.client);
    const prevWindow = (globalThis as any).window;
    const dispatchedEvents: Array<{ type: string; detail: any }> = [];

    (globalThis as any).window = {
      dispatchEvent: (ev: any) => {
        dispatchedEvents.push({ type: ev?.type, detail: ev?.detail });
        return true;
      }
    };

    try {
      safeLocalStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([
        { id: 'blk_seed_1', vrm: 'AU67 HCZ', reason: 'Seed' },
        { id: 'blk_local_1', vrm: 'LOC9 999', reason: 'Local block rule', expiryDate: '2099-12-31' },
        { id: 'blk_exp_1', vrm: 'EXP0 111', reason: 'Expired rule', expiryDate: '2024-01-01' }
      ]));

      const hydrated = await hydrateBlocklistFromServer();
      assert.ok(Array.isArray(hydrated));
      assert.equal(getBlocklistSyncStatus().isStale, false);
      assert.equal(getBlocklistSyncStatus().error, null);
      assert.equal(dispatchedEvents.some((e) => e.type === 'app-toast'), false);

      const saved = await saveBlocklist([
        { id: 'blk_seed_1', vrm: 'AU67 HCZ', reason: 'Seed' },
        { id: 'blk_local_1', vrm: 'LOC9 999', reason: 'Local block rule', expiryDate: '2099-12-31' },
        { id: 'blk_local_2', vrm: 'BLK5 555', reason: 'Saved locally without table' }
      ]);
      assert.equal(saved.some((i) => i.vrm === 'BLK5 555'), true);
      assert.equal(getBlocklistSyncStatus().isStale, false);

      assert.equal(await isVrmSilentBlocked('LOC9 999', '2026-11-25'), true);
      assert.equal(await isVrmSilentBlocked('BLK5 555', '2026-11-25'), true);
      assert.equal(await isVrmSilentBlocked('EXP0 111', '2026-11-25'), false);
      assert.equal(await isVrmSilentBlocked('AU67 HCZ', '2026-11-25'), true);
      assert.equal(await isVrmSilentBlocked('OK12 ABC', '2026-11-25'), false);
    } finally {
      setSupabaseClientOverride(null);
      if (prevWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = prevWindow;
      }
    }
  });
});
