import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CsvPermitRecord, ParsedVoucherData, resolveDateExpiry, cleanVoucherCodeValue, parseDateToISO, getTodayISO } from '../utils/csvParser';
import { apiFetch, loadRuntimeConfig } from './apiClient';

let runtimeSupabaseUrl: string | undefined = undefined;
let runtimeSupabaseAnonKey: string | undefined = undefined;

const DEFAULT_SUPABASE_URL = "https://ihhkitfpjmhudyzdhlpg.supabase.co";
const DEFAULT_SUPABASE_KEY = "sb_publishable_-7OtzoSb8zYjAXHR_Gk6dg_jAqiUyHQ";

const getEnvVar = (key: string): string | undefined => {
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env[key]) {
      return import.meta.env[key];
    }
  } catch (e) {}
  try {
    if (typeof process !== 'undefined' && process.env && process.env[key]) {
      return process.env[key];
    }
  } catch (e) {}
  return undefined;
};

const getRawUrl = (): string | undefined => {
  return runtimeSupabaseUrl || getEnvVar('VITE_SUPABASE_URL') || getEnvVar('SUPABASE_URL') || (typeof window !== 'undefined' ? (window as any).__SUPABASE_URL__ : undefined) || DEFAULT_SUPABASE_URL;
};

const getRawKey = (): string | undefined => {
  return runtimeSupabaseAnonKey || getEnvVar('VITE_SUPABASE_ANON_KEY') || getEnvVar('VITE_SUPABASE_KEY') || getEnvVar('VITE_SUPABASE_PUBLISHABLE_KEY') || getEnvVar('SUPABASE_KEY') || getEnvVar('SUPABASE_PUBLISHABLE_KEY') || getEnvVar('SUPABASE_ANON_KEY') || (typeof window !== 'undefined' ? (window as any).__SUPABASE_ANON_KEY__ : undefined) || DEFAULT_SUPABASE_KEY;
};

const getSupabaseUrl = (): string | undefined => {
  const url = getRawUrl();
  const key = getRawKey();
  if (url && url.startsWith('http')) return url;
  if (key && key.startsWith('http')) return key;
  return DEFAULT_SUPABASE_URL;
};

const getSupabaseAnonKey = (): string | undefined => {
  const url = getRawUrl();
  const key = getRawKey();
  if (key && !key.startsWith('http')) return key;
  if (url && !url.startsWith('http')) return url;
  return DEFAULT_SUPABASE_KEY;
};

export const initSupabaseConfig = async (): Promise<boolean> => {
  try {
    const data = await loadRuntimeConfig(true);
    if (data && data.supabaseUrl && data.supabaseAnonKey) {
      runtimeSupabaseUrl = data.supabaseUrl;
      runtimeSupabaseAnonKey = data.supabaseAnonKey;
      if (typeof window !== 'undefined') {
        (window as any).__SUPABASE_URL__ = data.supabaseUrl;
        (window as any).__SUPABASE_ANON_KEY__ = data.supabaseAnonKey;
      }
      supabaseClient = null;
    }
  } catch (err) {
    // Quiet fallback
  }
  return isSupabaseConfigured();
};

export const isSupabaseConfigured = (): boolean => {
  const url = getSupabaseUrl();
  const key = getSupabaseAnonKey();
  return Boolean(url && key && url.startsWith('http') && url.includes('.supabase.co'));
};

let supabaseClient: SupabaseClient | null = null;

export const getSupabaseClient = (): SupabaseClient | null => {
  if (!isSupabaseConfigured()) return null;
  if (!supabaseClient) {
    const url = getSupabaseUrl();
    const key = getSupabaseAnonKey();
    supabaseClient = createClient(url!, key!);
  }
  return supabaseClient;
};

export const resetVoucherInventory = async (): Promise<{ cleared: number; error: string | null }> => {
  try {
    const res = await apiFetch('/api/vouchers/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { cleared: 0, error: data?.error || `HTTP ${res.status}` };
    }
    return { cleared: data?.cleared ?? 0, error: data?.error || null };
  } catch (err: any) {
    return { cleared: 0, error: err?.message || 'Unknown error' };
  }
};

export const clearAllVouchers = resetVoucherInventory;

export const clearInvalidVoucherCodes = async (): Promise<{ cleared: number }> => {
  const badCodes = [
    '58CYWTPL0EN5H','WMFPJHQH1T3P2','14DPCBZ8CXC9A','AW5A4DIMZ6CNN',
    'NTY4ZD21412R7','3Q1JWTQIX3LHP','CIP9GY566Q3BE','V49NKHZ52MYFJ',
    'GIPM5RXTOVPRX','3O9P884XD8YFQ','4YQGWZ9HPJKLE','62ZCOVUAJP61S',
    '79OFDC7J4T6GZ','CPHE1E39CQNR5','XBMFYXBE47JRG','X2WYK6AS5XQ9Q',
    'CJOU7SMRF4MFG','REA4338YXRSBB','RE5BXW9I9DT67','R45EMSHO3WFDX',
    '132GK198IVU5A','QC7P160BV9ZMS','Q7Z9DCMK8NAMA'
  ];

  try {
    const res = await apiFetch('/api/permits/clear-invalid-vouchers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: badCodes })
    });
    if (!res.ok) return { cleared: 0 };
    const data = await res.json().catch(() => null);
    return { cleared: data?.cleared || 0 };
  } catch (err) {
    console.error('Failed to clear bad voucher codes:', err);
    return { cleared: 0 };
  }
};

export const checkSupabaseConnection = async (): Promise<{ connected: boolean; error?: string }> => {
  try {
    const res = await apiFetch('/api/admin/health-db');
    const data = await res.json().catch(() => null);
    if (res.ok && data?.connected) {
      return { connected: true };
    }
    return { connected: false, error: data?.error || `HTTP ${res.status}` };
  } catch (err: any) {
    return { connected: false, error: err?.message || String(err) };
  }
};

// ============================================================
// 1. PERMITS TABLE - WITH completion_time (Column C from Excel)
// ============================================================
export interface SupabasePermit {
  id: string;
  hospital: string;
  ward: string;
  date_required: string;
  date_expiry?: string;
  vrm: string;
  driver_name: string;
  phone?: string;
  email?: string;
  voucher_code?: string;
  replacement_code?: string;
  original_voucher_code?: string;
  pre_cancel_voucher_code?: string;
  start_time?: string;
  completion_time?: string;
  created_at?: string;
  cancellation_reason?: string | null;
}

const cancellationReasonForDb = (r: { cancellationReason?: string; isCancelled?: boolean; status?: string; voucherCode?: string }): string | null => {
  const cancelled = r.isCancelled === true || String(r.status || '').trim().toUpperCase() === 'CANCELLED' || String(r.voucherCode || '').trim().toUpperCase() === 'CANCELLED';
  return cancelled && r.cancellationReason ? String(r.cancellationReason) : null;
};

export const fetchPermitsFromSupabase = async (options?: { daysLimit?: number | null }): Promise<CsvPermitRecord[] | null> => {
  try {
    const daysLimit = options?.daysLimit !== undefined ? options.daysLimit : 90;
    const qs = daysLimit && daysLimit > 0 ? `?daysLimit=${encodeURIComponent(String(daysLimit))}` : '';
    const res = await apiFetch(`/api/permits${qs}`);
    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.permits)) return null;

    const allData: SupabasePermit[] = data.permits;
    let mappedRecords: CsvPermitRecord[] = allData.map((item: SupabasePermit) => ({
      id: item.id,
      formId: item.id,
      hospital: item.hospital || '',
      ward: item.ward || '',
      dateRequired: item.date_required || '',
      dateExpiry: resolveDateExpiry(item.date_required || '', item.date_expiry || ''),
      vrm: item.vrm || '',
      driverName: item.driver_name || '',
      phone: item.phone || '',
      email: item.email || '',
      voucherCode: item.voucher_code || '',
      replacementCode: item.replacement_code || undefined,
      originalVoucherCode: item.original_voucher_code || undefined,
      preCancelVoucherCode: item.pre_cancel_voucher_code || undefined,
      startTime: item.start_time || undefined,
      completionTime: item.completion_time || undefined,
      createdAt: item.created_at || undefined,
      created_at: item.created_at || undefined,
      cancellationReason: item.cancellation_reason || undefined,
    }));

    if (daysLimit && daysLimit > 0) {
      const nowObj = new Date();
      const cutoffTime = nowObj.getTime() - daysLimit * 86400000;
      const cutoffObj = new Date(cutoffTime);
      const cutoffISO = `${cutoffObj.getFullYear()}-${String(cutoffObj.getMonth() + 1).padStart(2, '0')}-${String(cutoffObj.getDate()).padStart(2, '0')}`;

      mappedRecords = mappedRecords.filter((r, idx) => {
        const item = allData[idx];
        const reqIso = r.dateRequired ? parseDateToISO(r.dateRequired) : "";
        const createdIso = item && item.created_at ? parseDateToISO(item.created_at) : "";
        const recordIso = reqIso || createdIso;
        if (!recordIso) return false;
        return recordIso >= cutoffISO;
      });
    }

    const resultRecords = mappedRecords as CsvPermitRecord[] & { totalCount?: number };
    resultRecords.totalCount = typeof data.totalCount === 'number' && data.totalCount > 0 ? data.totalCount : mappedRecords.length;
    return resultRecords;
  } catch (err) {
    console.warn('Failed to fetch permits via server API:', err);
    return null;
  }
};

export const syncPermitsToSupabase = async (records: CsvPermitRecord[], replaceAll: boolean = false): Promise<boolean> => {
  try {
    const basePayload = records.map(r => ({
      id: r.id,
      hospital: r.hospital || '',
      ward: r.ward || '',
      date_required: r.dateRequired || '',
      date_expiry: resolveDateExpiry(r.dateRequired || '', r.dateExpiry || ''),
      vrm: r.vrm || '',
      driver_name: r.driverName || '',
      phone: r.phone || null,
      email: r.email || null,
      voucher_code: r.voucherCode || null,
      replacement_code: r.replacementCode || null,
      original_voucher_code: r.originalVoucherCode || null,
      pre_cancel_voucher_code: r.preCancelVoucherCode || null,
      start_time: r.startTime || null,
      completion_time: r.completionTime || null,
      cancellation_reason: cancellationReasonForDb(r),
    }));

    const res = await apiFetch('/api/permits/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: basePayload, replaceAll })
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return Boolean(data?.success);
  } catch (err) {
    console.warn('Failed to sync permits via server API:', err);
    return false;
  }
};

export const updatePermitInSupabase = async (record: CsvPermitRecord): Promise<boolean> => {
  if (!record) return false;

  const clean = (v: any): string => {
    if (v === undefined || v === null) return '';
    const s = String(v).trim().replace(/^#/, '');
    if (!s || s === '-' || s.toLowerCase() === 'undefined' || s.toLowerCase() === 'null') return '';
    return s;
  };

  const cleanFormId = clean(record.formId);
  const cleanId = clean(record.id);

  let permitId = '';
  if (cleanFormId && !cleanFormId.startsWith('row-')) {
    permitId = cleanFormId;
  } else if (cleanId && !cleanId.startsWith('row-')) {
    permitId = cleanId;
  } else if (cleanFormId) {
    permitId = cleanFormId;
  } else if (cleanId) {
    permitId = cleanId;
  }

  if (!permitId) {
    console.warn('Cannot update permit in Supabase: record has no id/formId', record);
    return false;
  }

  const rawPayload = {
    id: permitId,
    hospital: record.hospital || (record as any).site || '',
    ward: record.ward || '',
    date_required: record.dateRequired || record.validFrom || '',
    date_expiry: resolveDateExpiry(record.dateRequired || record.validFrom || '', record.dateExpiry || record.validTo || ''),
    vrm: record.vrm || '',
    driver_name: record.driverName || (record as any).name || '',
    phone: record.phone || null,
    email: record.email || (record as any).driverEmail || null,
    voucher_code: record.voucherCode || (record as any).prePaidCode || null,
    replacement_code: record.replacementCode || null,
    original_voucher_code: record.originalVoucherCode || null,
    pre_cancel_voucher_code: record.preCancelVoucherCode || null,
    start_time: record.startTime || null,
    completion_time: record.completionTime || null,
    cancellation_reason: cancellationReasonForDb(record),
  };

  try {
    const res = await apiFetch('/api/permits/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rawPayload)
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      return Boolean(data?.success);
    }
    return false;
  } catch (err) {
    console.warn(`Failed to update permit ${permitId} via server API:`, err);
    return false;
  }
};

// ============================================================
// 2. VOUCHERS TABLE
// ============================================================
export interface SupabaseVoucher {
  code: string;
  vrm?: string;
  valid_from?: string;
  valid_to?: string;
  status?: string;
  is_used?: boolean;
  not_in_latest_export?: boolean;
}

let warnedMissingColumns = false;
const showMissingColumnsWarningOnce = () => {
  if (warnedMissingColumns) return;
  warnedMissingColumns = true;
  const msg = "Run add_voucher_status_columns.sql in Supabase so withdrawn vouchers persist";
  if (typeof window !== 'undefined') {
    if ((window as any).__showToast) {
      (window as any).__showToast(msg, "warning");
    } else {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: msg, type: 'warning' } }));
    }
  }
};

export const fetchVouchersFromSupabase = async (): Promise<ParsedVoucherData[] | null> => {
  try {
    const res = await apiFetch('/api/vouchers');
    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.vouchers)) return null;

    if (data.missingColumns) {
      showMissingColumnsWarningOnce();
    }

    const allData: SupabaseVoucher[] = data.vouchers;
    if (allData.length === 0) return [];

    const uniqueVouchers = new Map<string, ParsedVoucherData>();
    for (const item of allData) {
      if (!item.code) continue;
      const cleanCode = cleanVoucherCodeValue(item.code);
      const lower = cleanCode.toLowerCase();
      if (
        !cleanCode ||
        cleanCode === '-' ||
        lower === 'code' ||
        lower === 'voucher code' ||
        lower === 'vouchercode' ||
        lower === 'voucher_code' ||
        lower === 'vouchers' ||
        lower === 'qr code' ||
        lower === 'qrcode'
      ) {
        continue;
      }

      if (!uniqueVouchers.has(cleanCode)) {
        uniqueVouchers.set(cleanCode, {
          code: cleanCode,
          vrm: item.vrm || undefined,
          validFrom: item.valid_from || undefined,
          validTo: item.valid_to || undefined,
          status: item.status || "active",
          isUsed: Boolean(item.is_used || item.status === "withdrawn" || item.status === "used"),
          notInLatestExport: Boolean(item.not_in_latest_export)
        });
      }
    }

    return Array.from(uniqueVouchers.values());
  } catch (err) {
    console.warn('Failed to fetch vouchers via server API:', err);
    return null;
  }
};

export const syncVouchersToSupabase = async (vouchers: ParsedVoucherData[], replaceAll: boolean = false): Promise<boolean> => {
  try {
    const cleanPayloadMap = new Map<string, { code: string; vrm: string | null; valid_from: string | null; valid_to: string | null; status: string; is_used: boolean; not_in_latest_export: boolean }>();
    for (const v of vouchers) {
      if (!v.code) continue;
      const cleanCode = cleanVoucherCodeValue(v.code);
      const lower = cleanCode.toLowerCase();
      if (
        !cleanCode ||
        cleanCode === '-' ||
        lower === 'code' ||
        lower === 'voucher code' ||
        lower === 'vouchercode' ||
        lower === 'voucher_code' ||
        lower === 'vouchers' ||
        lower === 'qr code' ||
        lower === 'qrcode'
      ) {
        continue;
      }

      if (!cleanPayloadMap.has(cleanCode)) {
        cleanPayloadMap.set(cleanCode, {
          code: cleanCode,
          vrm: v.vrm || null,
          valid_from: v.validFrom || null,
          valid_to: v.validTo || null,
          status: v.status || "active",
          is_used: Boolean(v.isUsed || v.status === "withdrawn"),
          not_in_latest_export: Boolean(v.notInLatestExport)
        });
      }
    }

    const payload = Array.from(cleanPayloadMap.values());
    if (payload.length === 0 && !replaceAll) return true;

    const res = await apiFetch('/api/vouchers/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vouchers: payload, replaceAll })
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    if (data?.missingColumns) {
      showMissingColumnsWarningOnce();
    }
    return Boolean(data?.success);
  } catch (err) {
    console.warn('Failed to sync vouchers via server API:', err);
    return false;
  }
};

// ============================================================
// 3. DISPATCHED HISTORY TABLE (Server-Mediated)
// ============================================================
export interface SupabaseDispatched {
  key: string;
  dispatch_date: string;
  dispatch_by: string;
  vrm?: string;
  email?: string;
}

export const fetchDispatchedFromSupabase = async (): Promise<{
  dispatchedKeys: string[];
  dispatchDates: Record<string, string>;
  dispatchBy: Record<string, string>;
} | null> => {
  try {
    const res = await apiFetch('/api/dispatched');
    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.dispatched)) return null;

    const dispatchedKeys: string[] = [];
    const dispatchDates: Record<string, string> = {};
    const dispatchBy: Record<string, string> = {};
    data.dispatched.forEach((item: any) => {
      if (item && item.key) {
        const cleanKey = String(item.key).trim();
        if (cleanKey) {
          dispatchedKeys.push(cleanKey);
          if (item.dispatch_date) dispatchDates[cleanKey] = item.dispatch_date;
          if (item.dispatch_by) dispatchBy[cleanKey] = item.dispatch_by;
        }
      }
    });
    return { dispatchedKeys, dispatchDates, dispatchBy };
  } catch (err) {
    console.warn('Failed to fetch dispatched via server API:', err);
    return null;
  }
};

export const checkDispatchedKeysViaServer = async (
  keys: string[],
  includeHistory: boolean = false
): Promise<SupabaseDispatched[]> => {
  if (!keys || keys.length === 0) return [];
  try {
    const res = await apiFetch('/api/dispatched/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys, includeHistory })
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    return Array.isArray(data?.records) ? data.records : [];
  } catch {
    return [];
  }
};

export const testDispatchedWriteViaServer = async (): Promise<{ writable: boolean; isRlsError?: boolean; error?: string }> => {
  try {
    const res = await apiFetch('/api/admin/dispatch/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data) {
      return data;
    }
    return { writable: false, error: data?.error || `HTTP ${res.status}` };
  } catch (err: any) {
    return { writable: false, error: err?.message };
  }
};

export const cleanupCorruptedDispatchedKeys = async (): Promise<{ count: number; deletedKeys: string[] }> => {
  try {
    const res = await apiFetch('/api/admin/dispatch/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) return { count: 0, deletedKeys: [] };
    const data = await res.json().catch(() => null);
    return {
      count: data?.count || 0,
      deletedKeys: Array.isArray(data?.deletedKeys) ? data.deletedKeys : []
    };
  } catch (err) {
    console.error('[Server Cleanup Exception]', err);
    return { count: 0, deletedKeys: [] };
  }
};

export const bulkSyncDispatchedToSupabase = async (
  dispatchedList: Array<{ key: string; date?: string; by?: string; vrm?: string; email?: string }>
): Promise<boolean> => {
  if (!dispatchedList || dispatchedList.length === 0) return true;
  try {
    const res = await apiFetch('/api/admin/dispatch/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: dispatchedList })
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return Boolean(data?.success);
  } catch (err) {
    console.error('Exception in bulkSyncDispatchedToSupabase:', err);
    return false;
  }
};

export interface DispatchedSyncResult {
  success: boolean;
  error?: string;
  isRlsError?: boolean;
}

export const syncDispatchedToSupabase = async (
  key: string,
  date: string,
  by: string,
  vrm?: string,
  email?: string
): Promise<DispatchedSyncResult> => {
  if (!key || !key.trim()) {
    return { success: false, error: 'Key not available' };
  }

  const cleanKey = String(key).trim();
  const dateVal = date || getTodayISO();
  const byVal = by || 'System User';

  try {
    const adminRes = await apiFetch('/api/admin/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: cleanKey, date: dateVal, by: byVal, vrm, email })
    });
    if (adminRes.ok) {
      return { success: true };
    }
    const errBody = await adminRes.json().catch(() => null);
    return {
      success: false,
      error: errBody?.error || `Failed to write dispatch status (HTTP ${adminRes.status})`,
      isRlsError: adminRes.status === 403
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Database connection error',
      isRlsError: false
    };
  }
};

export const deleteDispatchedFromSupabase = async (key: string): Promise<boolean> => {
  if (!key || !key.trim()) return false;
  return deleteDispatchedKeysFromSupabase([key]);
};

export const deleteDispatchedKeysFromSupabase = async (keys: string[]): Promise<boolean> => {
  if (!keys || keys.length === 0) return false;
  const cleanKeys = Array.from(new Set(keys.map(k => String(k).trim()).filter(Boolean)));
  if (cleanKeys.length === 0) return true;

  try {
    const res = await apiFetch('/api/admin/dispatch/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: cleanKeys })
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return Boolean(data?.success);
  } catch (err) {
    console.error('[Server Delete Exception]', err);
    return false;
  }
};

export const clearSupabaseDispatches = async (): Promise<boolean> => {
  try {
    const res = await apiFetch('/api/admin/dispatch/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return Boolean(data?.success);
  } catch (err) {
    console.warn('Failed to clear dispatched via server API:', err);
    return false;
  }
};

export const subscribeToSupabaseChanges = (
  onChange: () => void
): (() => void) | null => {
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debouncedOnChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        onChange();
      }, 500);
    };

    const channelName = `realtime-dispatches-${Math.random().toString(36).substring(2, 9)}`;
    const channel = client
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'permits' },
        debouncedOnChange
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'vouchers' },
        debouncedOnChange
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'dispatched_history' },
        debouncedOnChange
      )
      .subscribe((status) => {
        console.log(`[Supabase Realtime] Channel ${channelName} status:`, status);
      });

    return () => {
      if (timer) clearTimeout(timer);
      client.removeChannel(channel);
    };
  } catch (err) {
    console.warn('Failed to subscribe to Supabase Realtime:', err);
    return null;
  }
};