import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CsvPermitRecord, ParsedVoucherData, resolveDateExpiry, cleanVoucherCodeValue, parseDateToISO, getTodayISO } from '../utils/csvParser';

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
    const res = await fetch('/api/config');
    if (res && res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.supabaseUrl && data.supabaseAnonKey) {
        runtimeSupabaseUrl = data.supabaseUrl;
        runtimeSupabaseAnonKey = data.supabaseAnonKey;
        if (typeof window !== 'undefined') {
          (window as any).__SUPABASE_URL__ = data.supabaseUrl;
          (window as any).__SUPABASE_ANON_KEY__ = data.supabaseAnonKey;
        }
        supabaseClient = null;
      }
    } else if (res && res.status !== 404) {
      console.warn(`⚠️ /api/config returned ${res.status}. Using default environment/local storage mode.`);
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
  console.log('CLEAR ALL VOUCHERS STARTED');
  const client = getSupabaseClient();
  if (!client) {
    console.log('CLEAR ALL VOUCHERS RESULT:', { cleared: 0, error: 'Supabase client not configured' });
    return { cleared: 0, error: null };
  }

  try {
    const { error, count } = await client
      .from('vouchers')
      .delete({ count: 'exact' })
      .neq('code', '___non_existent_code___');

    if (error) {
      console.error('clearAllVouchers error:', {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
        fullError: error
      });
      console.log('CLEAR ALL VOUCHERS RESULT:', {
        cleared: 0,
        error: error.message
      });
      return { cleared: 0, error: error.message };
    }

    const clearedCount = count ?? 0;
    console.log('CLEAR ALL VOUCHERS RESULT:', {
      cleared: clearedCount,
      error: null
    });
    return { cleared: clearedCount, error: null };
  } catch (err: any) {
    console.error('clearAllVouchers error:', {
      message: err?.message || 'Unknown exception',
      fullError: err
    });
    console.log('CLEAR ALL VOUCHERS RESULT:', {
      cleared: 0,
      error: err?.message || 'Unknown exception'
    });
    return { cleared: 0, error: err?.message || 'Unknown error' };
  }
};

export const clearAllVouchers = resetVoucherInventory;

export const clearInvalidVoucherCodes = async (): Promise<{ cleared: number }> => {
  const client = getSupabaseClient();
  if (!client) return { cleared: 0 };

  const badCodes = [
    '58CYWTPL0EN5H','WMFPJHQH1T3P2','14DPCBZ8CXC9A','AW5A4DIMZ6CNN',
    'NTY4ZD21412R7','3Q1JWTQIX3LHP','CIP9GY566Q3BE','V49NKHZ52MYFJ',
    'GIPM5RXTOVPRX','3O9P884XD8YFQ','4YQGWZ9HPJKLE','62ZCOVUAJP61S',
    '79OFDC7J4T6GZ','CPHE1E39CQNR5','XBMFYXBE47JRG','X2WYK6AS5XQ9Q',
    'CJOU7SMRF4MFG','REA4338YXRSBB','RE5BXW9I9DT67','R45EMSHO3WFDX',
    '132GK198IVU5A','QC7P160BV9ZMS','Q7Z9DCMK8NAMA'
  ];

  const { error, count } = await client
    .from('permits')
    .update({ voucher_code: null }, { count: 'exact' })
    .in('voucher_code', badCodes);

  if (error) {
    console.error('Failed to clear bad voucher codes:', error.message);
    return { cleared: 0 };
  }

  return { cleared: count || 0 };
};

export const checkSupabaseConnection = async (): Promise<{ connected: boolean; error?: string }> => {
  const client = getSupabaseClient();
  if (!client) return { connected: false, error: 'Supabase credentials missing' };

  try {
    const { error } = await client.from('permits').select('id').limit(1);
    if (error) {
      console.error('Supabase health check error:', error.message, error);
      return { connected: false, error: error.message };
    }
    return { connected: true };
  } catch (err: any) {
    console.error('Supabase connection exception:', err);
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
  start_time?: string;
  completion_time?: string;  // ✅ Column C from Excel
  created_at?: string;
  cancellation_reason?: string | null;
}

let cancellationColumnAvailable: boolean | null = null;
const isMissingCancellationColumnError = (err: any) => String(err?.message || err || '').toLowerCase().includes('cancellation_reason');
const PERMIT_SELECT_BASE = 'id, hospital, ward, date_required, date_expiry, vrm, driver_name, phone, email, voucher_code, start_time, completion_time, created_at';
const PERMIT_SELECT_WITH_REASON = PERMIT_SELECT_BASE + ', cancellation_reason';
const cancellationReasonForDb = (r: { cancellationReason?: string; isCancelled?: boolean; status?: string; voucherCode?: string }): string | null => {
  const cancelled = r.isCancelled === true || String(r.status || '').trim().toUpperCase() === 'CANCELLED' || String(r.voucherCode || '').trim().toUpperCase() === 'CANCELLED';
  return cancelled && r.cancellationReason ? String(r.cancellationReason) : null;
};

export const fetchPermitsFromSupabase = async (options?: { daysLimit?: number | null }): Promise<CsvPermitRecord[] | null> => {
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    let allData: SupabasePermit[] = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    const daysLimit = options?.daysLimit !== undefined ? options.daysLimit : 90;
    let cutoffISO = "";
    if (daysLimit && daysLimit > 0) {
      const nowObj = new Date();
      const cutoffTime = nowObj.getTime() - daysLimit * 86400000;
      const cutoffObj = new Date(cutoffTime);
      const cutoffYear = cutoffObj.getFullYear();
      const cutoffMonth = String(cutoffObj.getMonth() + 1).padStart(2, '0');
      const cutoffDay = String(cutoffObj.getDate()).padStart(2, '0');
      cutoffISO = `${cutoffYear}-${cutoffMonth}-${cutoffDay}`;
    }

    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;

      const selectCols = cancellationColumnAvailable === false ? PERMIT_SELECT_BASE : PERMIT_SELECT_WITH_REASON;
      let query = client
        .from('permits')
        .select(selectCols)
        .range(from, to)
        .order('created_at', { ascending: false });

      if (cutoffISO) {
        query = query.gte('created_at', cutoffISO);
      }

      let { data, error }: { data: any; error: any } = await query;

      if (error && cancellationColumnAvailable === null && isMissingCancellationColumnError(error)) {
        cancellationColumnAvailable = false;
        let retryQuery = client
          .from('permits')
          .select(PERMIT_SELECT_BASE)
          .range(from, to)
          .order('created_at', { ascending: false });
        if (cutoffISO) {
          retryQuery = retryQuery.gte('created_at', cutoffISO);
        }
        const retryRes: any = await retryQuery;
        data = retryRes.data;
        error = retryRes.error;
      }

      if (error) {
        console.warn('Supabase fetch permits error:', error.message);
        break;
      }

      if (cancellationColumnAvailable === null && !error) {
        cancellationColumnAvailable = true;
      }

      if (data && data.length > 0) {
        allData = allData.concat(data as unknown as SupabasePermit[]);
        if (data.length < pageSize) {
          hasMore = false;
        } else {
          page++;
        }
      } else {
        hasMore = false;
      }
    }

    if (allData.length === 0) return [];

    // Map Supabase data to CsvPermitRecord
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
      startTime: item.start_time || undefined,
      completionTime: item.completion_time || undefined,  // ✅ Map completion_time from Supabase
      createdAt: item.created_at || undefined,
      created_at: item.created_at || undefined,
      cancellationReason: item.cancellation_reason || undefined,
    }));

    if (daysLimit && daysLimit > 0) {
      const nowObj = new Date();
      const cutoffTime = nowObj.getTime() - daysLimit * 86400000;
      const cutoffObj = new Date(cutoffTime);
      const cutoffYear = cutoffObj.getFullYear();
      const cutoffMonth = String(cutoffObj.getMonth() + 1).padStart(2, '0');
      const cutoffDay = String(cutoffObj.getDate()).padStart(2, '0');
      const cutoffISO = `${cutoffYear}-${cutoffMonth}-${cutoffDay}`;

      mappedRecords = mappedRecords.filter((r, idx) => {
        const item = allData[idx];
        const reqIso = r.dateRequired ? parseDateToISO(r.dateRequired) : "";
        const createdIso = item && item.created_at ? parseDateToISO(item.created_at) : "";

        const recordIso = reqIso || createdIso;
        if (!recordIso) return false;

        return recordIso >= cutoffISO;
      });
    }

    let exactTotalCount = 0;
    try {
      const { count } = await client.from('permits').select('*', { count: 'exact', head: true });
      if (typeof count === 'number' && count > 0) {
        exactTotalCount = count;
      }
    } catch (e) {}

    const totalCount = exactTotalCount || mappedRecords.length;
    const resultRecords = mappedRecords as CsvPermitRecord[] & { totalCount?: number };
    resultRecords.totalCount = totalCount;
    return resultRecords;
  } catch (err) {
    console.warn('Failed to fetch permits from Supabase:', err);
    return null;
  }
};

export const syncPermitsToSupabase = async (records: CsvPermitRecord[], replaceAll: boolean = false): Promise<boolean> => {
  const client = getSupabaseClient();
  if (!client) return false;

  try {
    if (replaceAll) {
      await client.from('permits').delete().not('id', 'is', null);
      await client.from('permits').delete().neq('id', '___non_existent___');

      const existing = await client.from('permits').select('id');
      if (existing.data && existing.data.length > 0) {
        const idsToDelete = existing.data.map(d => d.id).filter(Boolean);
        for (let i = 0; i < idsToDelete.length; i += 200) {
          const chunk = idsToDelete.slice(i, i + 200);
          await client.from('permits').delete().in('id', chunk);
        }
      }
    }

    if (records.length === 0) return true;

    // Upsert payload with completion_time
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
      start_time: r.startTime || null,
      completion_time: r.completionTime || null,  // ✅ Sync completion_time to Supabase
      cancellation_reason: cancellationReasonForDb(r),
    }));

    const BATCH_SIZE = 400;
    let success = true;
    for (let i = 0; i < basePayload.length; i += BATCH_SIZE) {
      let chunk: any[] = basePayload.slice(i, i + BATCH_SIZE);
      if (cancellationColumnAvailable === false) {
        chunk = chunk.map(({ cancellation_reason, ...rest }) => rest);
      }
      let { error } = await client.from('permits').upsert(chunk, { onConflict: 'id' });
      if (error && cancellationColumnAvailable !== false && isMissingCancellationColumnError(error)) {
        cancellationColumnAvailable = false;
        const retryChunk = chunk.map(({ cancellation_reason, ...rest }) => rest);
        const retryRes = await client.from('permits').upsert(retryChunk, { onConflict: 'id' });
        error = retryRes.error;
      }
      if (error) {
        console.warn(`Supabase sync permits error on batch starting at index ${i}:`, error.message);
        success = false;
      }
    }
    if (success && cancellationColumnAvailable === null) {
      cancellationColumnAvailable = true;
    }
    return success;
  } catch (err) {
    console.warn('Failed to sync permits to Supabase:', err);
    return false;
  }
};

export const updatePermitInSupabase = async (record: CsvPermitRecord): Promise<boolean> => {
  const client = getSupabaseClient();
  if (!client || !record) return false;

  const clean = (v: any): string => {
    if (v === undefined || v === null) return '';
    const s = String(v).trim().replace(/^#/, '');
    if (!s || s === '-' || s.toLowerCase() === 'undefined' || s.toLowerCase() === 'null') return '';
    return s;
  };

  const cleanFormId = clean(record.formId);
  const cleanId = clean(record.id);

  // Determine authoritative permit ID
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

  const basePayload = {
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
    start_time: record.startTime || null,
    completion_time: record.completionTime || null,
    cancellation_reason: cancellationReasonForDb(record),
  };

  const getPayloadForDb = () => {
    if (cancellationColumnAvailable === false) {
      const { cancellation_reason, ...rest } = basePayload;
      return rest;
    }
    return basePayload;
  };

  try {
    let payload = getPayloadForDb();
    let { error } = await client.from('permits').upsert(payload, { onConflict: 'id' });
    if (error && cancellationColumnAvailable !== false && isMissingCancellationColumnError(error)) {
      cancellationColumnAvailable = false;
      payload = getPayloadForDb();
      const retryRes = await client.from('permits').upsert(payload, { onConflict: 'id' });
      error = retryRes.error;
    }
    if (error) {
      console.warn(`Supabase client update permit error for id ${permitId}:`, error.message);
      // Attempt server proxy fallback if client-side update encounters RLS or network issue
      try {
        const res = await fetch('/api/permits/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(getPayloadForDb())
        });
        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (data?.success) {
            if (cancellationColumnAvailable === null) cancellationColumnAvailable = true;
            return true;
          }
        }
      } catch (fallbackErr) {}
      return false;
    }
    if (cancellationColumnAvailable === null) {
      cancellationColumnAvailable = true;
    }
    return true;
  } catch (err) {
    console.warn(`Failed to update permit ${permitId} in Supabase:`, err);
    try {
      const res = await fetch('/api/permits/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(getPayloadForDb())
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.success) {
          if (cancellationColumnAvailable === null) cancellationColumnAvailable = true;
          return true;
        }
      }
    } catch (fallbackErr) {}
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
}

export const fetchVouchersFromSupabase = async (): Promise<ParsedVoucherData[] | null> => {
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    let allData: SupabaseVoucher[] = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;

      const { data, error } = await client
        .from('vouchers')
        .select('code, vrm, valid_from, valid_to')
        .range(from, to);

      if (error) {
        console.warn('Supabase fetch vouchers error:', error.message);
        break;
      }

      if (data && data.length > 0) {
        allData = allData.concat(data as SupabaseVoucher[]);
        if (data.length < pageSize) {
          hasMore = false;
        } else {
          page++;
        }
      } else {
        hasMore = false;
      }
    }

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
          validTo: item.valid_to || undefined
        });
      }
    }

    return Array.from(uniqueVouchers.values());
  } catch (err) {
    console.warn('Failed to fetch vouchers from Supabase:', err);
    return null;
  }
};

export const syncVouchersToSupabase = async (vouchers: ParsedVoucherData[], replaceAll: boolean = false): Promise<boolean> => {
  const client = getSupabaseClient();
  if (!client) return false;

  try {
    if (replaceAll) {
      await client.from('vouchers').delete().not('code', 'is', null);
      await client.from('vouchers').delete().neq('code', '___non_existent___');

      const existing = await client.from('vouchers').select('code');
      if (existing.data && existing.data.length > 0) {
        const codesToDelete = existing.data.map(d => d.code).filter(Boolean);
        for (let i = 0; i < codesToDelete.length; i += 200) {
          const chunk = codesToDelete.slice(i, i + 200);
          await client.from('vouchers').delete().in('code', chunk);
        }
      }
    }

    const cleanPayloadMap = new Map<string, { code: string; vrm: string | null; valid_from: string | null; valid_to: string | null }>();
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
          valid_to: v.validTo || null
        });
      }
    }

    const payload = Array.from(cleanPayloadMap.values());
    if (payload.length === 0) return true;

    const BATCH_SIZE = 400;
    let success = true;
    for (let i = 0; i < payload.length; i += BATCH_SIZE) {
      const chunk = payload.slice(i, i + BATCH_SIZE);
      const { error } = await client.from('vouchers').upsert(chunk, { onConflict: 'code' });
      if (error) {
        console.warn(`Supabase sync vouchers error on batch starting at index ${i}:`, error.message);
        success = false;
      }
    }
    return success;
  } catch (err) {
    console.warn('Failed to sync vouchers to Supabase:', err);
    return false;
  }
};

// ============================================================
// 3. DISPATCHED HISTORY TABLE
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
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    let allData: SupabaseDispatched[] = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;

      const { data, error } = await client
        .from('dispatched_history')
        .select('key, dispatch_date, dispatch_by')
        .range(from, to);

      if (error) {
        console.warn('Supabase fetch dispatched error:', error.message);
        break;
      }

      if (data && data.length > 0) {
        allData = allData.concat(data as SupabaseDispatched[]);
        if (data.length < pageSize) {
          hasMore = false;
        } else {
          page++;
        }
      } else {
        hasMore = false;
      }
    }

    const dispatchedKeys: string[] = [];
    const dispatchDates: Record<string, string> = {};
    const dispatchBy: Record<string, string> = {};

    allData.forEach((item: SupabaseDispatched) => {
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
    console.warn('Failed to fetch dispatched from Supabase:', err);
    return null;
  }
};

export const cleanupCorruptedDispatchedKeys = async (): Promise<{ count: number; deletedKeys: string[] }> => {
  const client = getSupabaseClient();
  if (!client) return { count: 0, deletedKeys: [] };

  try {
    const { data, error } = await client.from('dispatched_history').select('*');
    if (error || !data) return { count: 0, deletedKeys: [] };

    const invalidRows = data.filter((item: SupabaseDispatched) => {
      const k = (item.key || '').trim();
      if (!k) return true;
      if (/^\d{8}$/.test(k)) return true;
      if (/^\d{4}-\d{2}-\d{2}$/.test(k)) return true;
      if (k.toUpperCase() === 'UNDEFINED' || k.toUpperCase() === 'NULL') return true;
      return false;
    });

    const deletedKeys: string[] = invalidRows.map((item: SupabaseDispatched) => item.key);

    if (deletedKeys.length > 0) {
      for (const badKey of deletedKeys) {
        const { error: delErr } = await client.from('dispatched_history').delete().eq('key', badKey);
        if (delErr) {
          console.error('[Supabase Cleanup Error] Failed to delete corrupted key:', delErr.message);
        }
      }
    }

    return { count: deletedKeys.length, deletedKeys };
  } catch (err) {
    console.error('[Supabase Cleanup Exception]', err);
    return { count: 0, deletedKeys: [] };
  }
};

export const bulkSyncDispatchedToSupabase = async (
  dispatchedList: Array<{ key: string; date?: string; by?: string; vrm?: string; email?: string }>
): Promise<boolean> => {
  const client = getSupabaseClient();
  if (!client || !dispatchedList || dispatchedList.length === 0) return true;

  try {
    const payload = dispatchedList
      .filter(item => item && item.key && String(item.key).trim())
      .map(item => ({
        key: String(item.key).trim(),
        dispatch_date: item.date || getTodayISO(),
        dispatch_by: item.by || 'System User',
        vrm: item.vrm ? String(item.vrm).trim() : null,
        email: item.email ? String(item.email).trim() : null
      }));

    if (payload.length === 0) return true;

    const BATCH_SIZE = 400;
    let success = true;
    for (let i = 0; i < payload.length; i += BATCH_SIZE) {
      const chunk = payload.slice(i, i + BATCH_SIZE);
      const { error } = await client.from('dispatched_history').upsert(chunk, { onConflict: 'key' });
      if (error) {
        console.warn(`Supabase bulk sync dispatched error on batch starting at index ${i}:`, error.message);
        const basicChunk = chunk.map(c => ({
          key: c.key,
          dispatch_date: c.dispatch_date,
          dispatch_by: c.dispatch_by
        }));
        const { error: basicErr } = await client.from('dispatched_history').upsert(basicChunk, { onConflict: 'key' });
        if (basicErr) {
          console.error('Basic chunk upsert also failed:', basicErr.message);
          success = false;
        }
      }
    }
    return success;
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
  const client = getSupabaseClient();
  if (!client || !key || !key.trim()) {
    return { success: false, error: 'Database client or key not available' };
  }

  const cleanKey = String(key).trim();
  const dateVal = date || getTodayISO();
  const byVal = by || 'System User';

  const fullPayload = {
    key: cleanKey,
    dispatch_date: dateVal,
    dispatch_by: byVal,
    vrm: vrm ? String(vrm).trim() : null,
    email: email ? String(email).trim() : null
  };

  try {
    const { error } = await client.from('dispatched_history').upsert(fullPayload, { onConflict: 'key' });

    if (!error) {
      return { success: true };
    }

    const isRls = error.code === '42501' || error.message?.toLowerCase().includes('row-level security') || error.message?.toLowerCase().includes('violates');

    const basicPayload = {
      key: cleanKey,
      dispatch_date: dateVal,
      dispatch_by: byVal
    };

    const { error: basicErr } = await client.from('dispatched_history').upsert(basicPayload, { onConflict: 'key' });

    if (!basicErr) {
      return { success: true };
    }

    // 2. Try the log_dispatch RPC function (SECURITY DEFINER bypasses RLS)
    try {
      const { error: rpcErr } = await client.rpc('log_dispatch', {
        p_key: cleanKey,
        p_dispatch_date: dateVal,
        p_dispatch_by: byVal,
        p_vrm: vrm ? String(vrm).trim() : null,
        p_email: email ? String(email).trim() : null
      });
      if (!rpcErr) {
        return { success: true };
      }
    } catch (e) {
      // RPC might not be created in Supabase yet
    }

    // 3. Try administrative endpoint /api/admin/dispatch
    try {
      const adminRes = await fetch('/api/admin/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: cleanKey, date: dateVal, by: byVal, vrm, email })
      });
      if (adminRes.ok) {
        return { success: true };
      }
    } catch (e) {
      // Admin endpoint offline or unconfigured
    }

    const isRlsBasic = basicErr.code === '42501' || basicErr.message?.toLowerCase().includes('row-level security') || basicErr.message?.toLowerCase().includes('violates');

    console.warn('[Supabase Write Warning] Upsert failed:', basicErr.message, { code: basicErr.code, isRls: isRls || isRlsBasic });
    return {
      success: false,
      error: basicErr.message || error.message || 'Failed to write dispatch status to database',
      isRlsError: isRls || isRlsBasic
    };
  } catch (err: any) {
    console.warn('[Supabase Write Exception]', err);
    return {
      success: false,
      error: err?.message || 'Database connection error',
      isRlsError: false
    };
  }
};

export const deleteDispatchedFromSupabase = async (key: string): Promise<boolean> => {
  const client = getSupabaseClient();
  if (!client || !key || !key.trim()) return false;

  const cleanKey = String(key).trim();
  try {
    const { error } = await client.from('dispatched_history').delete().eq('key', cleanKey);
    if (error) {
      console.error('[Supabase Delete Error] Delete failed:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Supabase Delete Exception]', err);
    return false;
  }
};

export const deleteDispatchedKeysFromSupabase = async (keys: string[]): Promise<boolean> => {
  const client = getSupabaseClient();
  if (!client || !keys || keys.length === 0) return false;

  const cleanKeys = Array.from(new Set(keys.map(k => String(k).trim()).filter(Boolean)));
  if (cleanKeys.length === 0) return true;

  try {
    const { error } = await client.from('dispatched_history').delete().in('key', cleanKeys);
    if (error) {
      console.warn('[Supabase Delete Warning] Batch delete failed, falling back to individual deletes:', error.message);
      let allOk = true;
      for (const k of cleanKeys) {
        const ok = await deleteDispatchedFromSupabase(k);
        if (!ok) allOk = false;
      }
      return allOk;
    }
    return true;
  } catch (err) {
    console.error('[Supabase Delete Exception]', err);
    return false;
  }
};

export const clearSupabaseDispatches = async (): Promise<boolean> => {
  const client = getSupabaseClient();
  if (!client) return false;

  try {
    const { error } = await client.from('dispatched_history').delete().neq('key', '');
    if (error) {
      console.warn('Supabase clear dispatched error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Failed to clear dispatched from Supabase:', err);
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