import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CsvPermitRecord, ParsedVoucherData, resolveDateExpiry, cleanVoucherCodeValue, parseDateToISO, getTodayISO } from '../utils/csvParser';

const DEFAULT_SUPABASE_URL = "https://ihhkitfpjmhudyzdhlpg.supabase.co";
const DEFAULT_SUPABASE_KEY = "sb_publishable_-7OtzoSb8zYjAXHR_Gk6dg_jAqiUyHQ";

const getEnvVar = (key: string): string | undefined => {
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env[key]) {
      return import.meta.env[key];
    }
  } catch {}
  try {
    if (typeof process !== 'undefined' && process.env && process.env[key]) {
      return process.env[key];
    }
  } catch {}
  return undefined;
};

const getRawUrl = (): string | undefined => {
  return (
    getEnvVar('VITE_SUPABASE_URL') ||
    getEnvVar('SUPABASE_URL') ||
    (typeof window !== 'undefined' ? (window as any).__SUPABASE_URL__ : undefined) ||
    DEFAULT_SUPABASE_URL
  );
};

const getRawKey = (): string | undefined => {
  return (
    getEnvVar('VITE_SUPABASE_ANON_KEY') ||
    getEnvVar('VITE_SUPABASE_KEY') ||
    getEnvVar('VITE_SUPABASE_PUBLISHABLE_KEY') ||
    getEnvVar('SUPABASE_ANON_KEY') ||
    getEnvVar('SUPABASE_KEY') ||
    getEnvVar('SUPABASE_PUBLISHABLE_KEY') ||
    (typeof window !== 'undefined' ? (window as any).__SUPABASE_ANON_KEY__ : undefined) ||
    DEFAULT_SUPABASE_KEY
  );
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

export function isMissingSupabaseSchemaError(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || '').trim().toUpperCase();
  const msg = String(err.message || err.details || err.hint || '').toLowerCase();
  if (code === 'PGRST205' || code === 'PGRST202' || code === '42P01' || code === '42883') {
    return true;
  }
  return (
    msg.includes('could not find the table') ||
    msg.includes('could not find the function') ||
    msg.includes('in the schema cache') ||
    (msg.includes('relation') && msg.includes('does not exist')) ||
    (msg.includes('function') && msg.includes('does not exist'))
  );
}

export const initSupabaseConfig = async (): Promise<boolean> => {
  return isSupabaseConfigured();
};

export const isSupabaseConfigured = (): boolean => {
  if (overrideSupabaseClient) return true;
  const url = getSupabaseUrl();
  const key = getSupabaseAnonKey();
  return Boolean(url && key && url.startsWith('http') && url.includes('.supabase.co'));
};

let supabaseClient: SupabaseClient | null = null;
let overrideSupabaseClient: SupabaseClient | null = null;

export const setSupabaseClientOverride = (client: SupabaseClient | any | null): void => {
  overrideSupabaseClient = client;
};

export const getSupabaseClient = (): SupabaseClient | null => {
  if (overrideSupabaseClient) return overrideSupabaseClient;
  if (!isSupabaseConfigured()) return null;
  if (!supabaseClient) {
    const url = getSupabaseUrl();
    const key = getSupabaseAnonKey();
    supabaseClient = createClient(url!, key!, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });
  }
  return supabaseClient;
};

export const resetVoucherInventory = async (): Promise<{ cleared: number; error: string | null }> => {
  const client = getSupabaseClient();
  if (!client) return { cleared: 0, error: 'Supabase not configured' };

  try {
    const { error, count } = await client
      .from('vouchers')
      .delete({ count: 'exact' })
      .neq('code', '___non_existent_code___');

    if (error) {
      if (isMissingSupabaseSchemaError(error)) {
        console.warn('Vouchers table unavailable in Supabase, continuing in local mode:', error.message);
        return { cleared: 0, error: null };
      }
      return { cleared: 0, error: error.message };
    }
    return { cleared: count ?? 0, error: null };
  } catch (err: any) {
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

  try {
    const { error, count } = await client
      .from('permits')
      .update({ voucher_code: null }, { count: 'exact' })
      .in('voucher_code', badCodes);
    if (error) {
      if (!isMissingSupabaseSchemaError(error)) {
        console.warn('Failed to clear bad voucher codes:', error.message);
      }
      return { cleared: 0 };
    }
    return { cleared: count || 0 };
  } catch (err) {
    console.warn('Failed to clear bad voucher codes:', err);
    return { cleared: 0 };
  }
};

export const checkSupabaseConnection = async (): Promise<{ connected: boolean; error?: string }> => {
  const client = getSupabaseClient();
  if (!client) return { connected: false, error: 'Supabase not configured' };

  try {
    const { error } = await client.from('permits').select('id').limit(1);
    if (error) {
      return { connected: false, error: error.message };
    }
    return { connected: true };
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
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    const daysLimit = options?.daysLimit !== undefined ? options.daysLimit : 90;
    let cutoffISO = '';
    if (daysLimit && Number.isFinite(daysLimit) && daysLimit > 0) {
      const cutoffObj = new Date(Date.now() - daysLimit * 86400000);
      cutoffISO = `${cutoffObj.getFullYear()}-${String(cutoffObj.getMonth() + 1).padStart(2, '0')}-${String(cutoffObj.getDate()).padStart(2, '0')}`;
    }

    let allData: SupabasePermit[] = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;
      let query = client
        .from('permits')
        .select('*')
        .range(from, to)
        .order('created_at', { ascending: false });

      if (cutoffISO) {
        query = query.gte('created_at', cutoffISO);
      }

      const { data, error } = await query;
      if (error) {
        console.warn('Failed to fetch permits from Supabase:', error.message);
        return null;
      }

      if (data && data.length > 0) {
        allData = allData.concat(data as SupabasePermit[]);
        if (data.length < pageSize) {
          hasMore = false;
        } else {
          page++;
        }
      } else {
        hasMore = false;
      }
    }

    let exactTotalCount = allData.length;
    try {
      const { count } = await client.from('permits').select('*', { count: 'exact', head: true });
      if (typeof count === 'number' && count > 0) {
        exactTotalCount = count;
      }
    } catch {}

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
      const cutoffObj = new Date(Date.now() - daysLimit * 86400000);
      const localCutoffISO = `${cutoffObj.getFullYear()}-${String(cutoffObj.getMonth() + 1).padStart(2, '0')}-${String(cutoffObj.getDate()).padStart(2, '0')}`;

      mappedRecords = mappedRecords.filter((r, idx) => {
        const item = allData[idx];
        const reqIso = r.dateRequired ? parseDateToISO(r.dateRequired) : "";
        const createdIso = item && item.created_at ? parseDateToISO(item.created_at) : "";
        const recordIso = reqIso || createdIso;
        if (!recordIso) return false;
        return recordIso >= localCutoffISO;
      });
    }

    const resultRecords = mappedRecords as CsvPermitRecord[] & { totalCount?: number };
    resultRecords.totalCount = exactTotalCount > 0 ? exactTotalCount : mappedRecords.length;
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
    if (replaceAll === true) {
      const existing = await client.from('permits').select('id');
      if (existing.error) {
        if (isMissingSupabaseSchemaError(existing.error)) return false;
        return false;
      }
      if (existing.data && existing.data.length > 0) {
        const idsToDelete = existing.data.map((d: any) => d.id).filter(Boolean);
        for (let i = 0; i < idsToDelete.length; i += 200) {
          const chunk = idsToDelete.slice(i, i + 200);
          const { error: delErr } = await client.from('permits').delete().in('id', chunk);
          if (delErr) {
            return false;
          }
        }
      }
    }

    const basePayload = records
      .filter((r) => r && r.id)
      .map((r) => ({
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

    if (basePayload.length === 0) return true;

    const BATCH_SIZE = 400;
    let skipCancellation = false;
    let skipReplacement = false;

    for (let i = 0; i < basePayload.length; i += BATCH_SIZE) {
      const prepareChunk = () =>
        basePayload.slice(i, i + BATCH_SIZE).map((item) => {
          const copy: Record<string, any> = { ...item };
          if (skipCancellation) delete copy.cancellation_reason;
          if (skipReplacement) {
            delete copy.replacement_code;
            delete copy.original_voucher_code;
            delete copy.pre_cancel_voucher_code;
          }
          return copy;
        });

      let { error } = await client.from('permits').upsert(prepareChunk(), { onConflict: 'id' });
      if (error) {
        const msg = String(error.message || '').toLowerCase();
        if (
          msg.includes('cancellation_reason') ||
          msg.includes('replacement_code') ||
          msg.includes('original_voucher_code') ||
          msg.includes('pre_cancel_voucher_code')
        ) {
          if (msg.includes('cancellation_reason')) skipCancellation = true;
          if (
            msg.includes('replacement_code') ||
            msg.includes('original_voucher_code') ||
            msg.includes('pre_cancel_voucher_code')
          ) {
            skipReplacement = true;
          }
          const retryRes = await client.from('permits').upsert(prepareChunk(), { onConflict: 'id' });
          error = retryRes.error;
        }
      }
      if (error) {
        console.warn('Failed to sync permits batch to Supabase:', error.message);
        return false;
      }
    }

    return true;
  } catch (err) {
    console.warn('Failed to sync permits to Supabase:', err);
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

  const client = getSupabaseClient();
  if (!client) return false;

  const rawPayload: Record<string, any> = {
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
    let { error } = await client.from('permits').upsert(rawPayload, { onConflict: 'id' });
    if (
      error &&
      (String(error.message || '').toLowerCase().includes('cancellation_reason') ||
        String(error.message || '').toLowerCase().includes('replacement_code') ||
        String(error.message || '').toLowerCase().includes('original_voucher_code') ||
        String(error.message || '').toLowerCase().includes('pre_cancel_voucher_code'))
    ) {
      const fallbackPayload = { ...rawPayload };
      if (String(error.message || '').toLowerCase().includes('cancellation_reason')) {
        delete fallbackPayload.cancellation_reason;
      }
      if (
        String(error.message || '').toLowerCase().includes('replacement_code') ||
        String(error.message || '').toLowerCase().includes('original_voucher_code') ||
        String(error.message || '').toLowerCase().includes('pre_cancel_voucher_code')
      ) {
        delete fallbackPayload.replacement_code;
        delete fallbackPayload.original_voucher_code;
        delete fallbackPayload.pre_cancel_voucher_code;
      }
      const retryRes = await client.from('permits').upsert(fallbackPayload, { onConflict: 'id' });
      error = retryRes.error;
    }

    if (error) {
      console.warn(`Supabase permit update error for id ${permitId}:`, error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.warn(`Failed to update permit ${permitId} in Supabase:`, err);
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
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    let allData: SupabaseVoucher[] = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;
    let missingColumns = false;

    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;

      let result: any = await client
        .from('vouchers')
        .select('code, vrm, valid_from, valid_to, status, is_used, not_in_latest_export')
        .range(from, to);

      if (
        result.error &&
        result.error.message &&
        (result.error.message.includes('not_in_latest_export') ||
          result.error.message.includes('status') ||
          result.error.message.includes('is_used') ||
          result.error.message.includes('column'))
      ) {
        missingColumns = true;
        result = await client
          .from('vouchers')
          .select('code, vrm, valid_from, valid_to, status, is_used')
          .range(from, to);

        if (
          result.error &&
          result.error.message &&
          (result.error.message.includes('status') ||
            result.error.message.includes('is_used') ||
            result.error.message.includes('column'))
        ) {
          result = await client
            .from('vouchers')
            .select('code, vrm, valid_from, valid_to')
            .range(from, to);
        }
      }

      if (result.error) {
        console.warn('Failed to fetch vouchers from Supabase:', result.error.message);
        return null;
      }

      if (result.data && result.data.length > 0) {
        allData = allData.concat(result.data as SupabaseVoucher[]);
        if (result.data.length < pageSize) {
          hasMore = false;
        } else {
          page++;
        }
      } else {
        hasMore = false;
      }
    }

    if (missingColumns) {
      showMissingColumnsWarningOnce();
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
          validTo: item.valid_to || undefined,
          status: item.status || "active",
          isUsed: Boolean(item.is_used || item.status === "withdrawn" || item.status === "used"),
          notInLatestExport: Boolean(item.not_in_latest_export)
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
    if (replaceAll === true) {
      const existing = await client.from('vouchers').select('code');
      if (existing.error) return false;
      if (existing.data && existing.data.length > 0) {
        const codesToDelete = existing.data.map((d: any) => d.code).filter(Boolean);
        for (let i = 0; i < codesToDelete.length; i += 200) {
          const chunk = codesToDelete.slice(i, i + 200);
          const { error: delErr } = await client.from('vouchers').delete().in('code', chunk);
          if (delErr) return false;
        }
      }
    }

    const cleanPayloadMap = new Map<
      string,
      {
        code: string;
        vrm: string | null;
        valid_from: string | null;
        valid_to: string | null;
        status: string;
        is_used: boolean;
        not_in_latest_export: boolean;
      }
    >();

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
    if (payload.length === 0) return true;

    const BATCH_SIZE = 400;
    let includeAllCols = 2;
    let missingColumns = false;

    for (let i = 0; i < payload.length; i += BATCH_SIZE) {
      const chunk = payload.slice(i, i + BATCH_SIZE);
      const mapChunk = (level: number) =>
        level === 2
          ? chunk
          : level === 1
            ? chunk.map((c) => ({ code: c.code, vrm: c.vrm, valid_from: c.valid_from, valid_to: c.valid_to, status: c.status, is_used: c.is_used }))
            : chunk.map((c) => ({ code: c.code, vrm: c.vrm, valid_from: c.valid_from, valid_to: c.valid_to }));

      let { error } = await client.from('vouchers').upsert(mapChunk(includeAllCols), { onConflict: 'code' });
      if (
        error &&
        error.message &&
        (error.message.includes('not_in_latest_export') ||
          error.message.includes('status') ||
          error.message.includes('is_used') ||
          error.message.includes('column'))
      ) {
        missingColumns = true;
        includeAllCols = includeAllCols === 2 ? 1 : 0;
        const retryRes = await client.from('vouchers').upsert(mapChunk(includeAllCols), { onConflict: 'code' });
        error = retryRes.error;
        if (error && includeAllCols === 1) {
          includeAllCols = 0;
          const baseRes = await client.from('vouchers').upsert(mapChunk(0), { onConflict: 'code' });
          error = baseRes.error;
        }
      }
      if (error) {
        console.warn('Failed to sync vouchers batch to Supabase:', error.message);
        return false;
      }
    }

    if (missingColumns) {
      showMissingColumnsWarningOnce();
    }
    return true;
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
    let allData: any[] = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const from = page * pageSize;
      const to = from + pageSize - 1;
      const initial = await client
        .from('dispatched_history')
        .select('key, dispatch_date, dispatch_by, vrm, email')
        .range(from, to);
      let data: any[] | null = initial.data;
      let error = initial.error;

      if (error && error.message && error.message.toLowerCase().includes('column')) {
        const retry = await client
          .from('dispatched_history')
          .select('key, dispatch_date, dispatch_by')
          .range(from, to);
        data = retry.data;
        error = retry.error;
      }

      if (error) {
        console.warn('Failed to fetch dispatched history from Supabase:', error.message);
        return null;
      }

      if (data && data.length > 0) {
        allData = allData.concat(data);
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
    allData.forEach((item: any) => {
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

export const checkDispatchedKeysViaServer = async (
  keys: string[],
  includeHistory: boolean = false
): Promise<SupabaseDispatched[]> => {
  if (!keys || keys.length === 0) return [];
  const client = getSupabaseClient();
  if (!client) return [];

  try {
    const cleanKeys = keys.map((k) => String(k || '').trim()).filter(Boolean);
    if (cleanKeys.length === 0) return [];
    const selectCols = includeHistory ? 'key, dispatch_date, dispatch_by, vrm, email' : 'key';
    const initial = await client
      .from('dispatched_history')
      .select(selectCols)
      .in('key', cleanKeys);
    let data: any[] | null = initial.data;
    let error = initial.error;
    if (error && includeHistory && error.message && error.message.toLowerCase().includes('column')) {
      const retry = await client
        .from('dispatched_history')
        .select('key, dispatch_date, dispatch_by')
        .in('key', cleanKeys);
      data = retry.data;
      error = retry.error;
    }
    if (error) return [];
    return (Array.isArray(data) ? data : []) as unknown as SupabaseDispatched[];
  } catch {
    return [];
  }
};

export const testDispatchedWriteViaServer = async (): Promise<{ writable: boolean; isRlsError?: boolean; error?: string }> => {
  const client = getSupabaseClient();
  if (!client) return { writable: false, error: 'Supabase not configured' };

  try {
    const probeKey = '___rls_probe_ping___';
    const { error: insErr } = await client.from('dispatched_history').upsert(
      {
        key: probeKey,
        dispatch_date: getTodayISO(),
        dispatch_by: 'Probe Ping'
      },
      { onConflict: 'key' }
    );
    if (insErr) {
      const isRls =
        insErr.code === '42501' ||
        String(insErr.message || '').toLowerCase().includes('row-level security') ||
        String(insErr.message || '').toLowerCase().includes('violates');
      return { writable: false, isRlsError: isRls, error: insErr.message };
    }
    await client.from('dispatched_history').delete().eq('key', probeKey);
    return { writable: true };
  } catch (err: any) {
    return { writable: false, error: err?.message };
  }
};

export const cleanupCorruptedDispatchedKeys = async (): Promise<{ count: number; deletedKeys: string[] }> => {
  const client = getSupabaseClient();
  if (!client) return { count: 0, deletedKeys: [] };

  try {
    const { data, error } = await client.from('dispatched_history').select('key');
    if (error || !data) return { count: 0, deletedKeys: [] };

    const invalidKeys = data
      .filter((item: any) => {
        const k = String(item?.key || '').trim();
        if (!k) return true;
        if (/^\d{8}$/.test(k)) return true;
        if (/^\d{4}-\d{2}-\d{2}$/.test(k)) return true;
        if (k.toUpperCase() === 'UNDEFINED' || k.toUpperCase() === 'NULL') return true;
        return false;
      })
      .map((item: any) => item.key);

    if (invalidKeys.length > 0) {
      const { error: delErr } = await client.from('dispatched_history').delete().in('key', invalidKeys);
      if (delErr) return { count: 0, deletedKeys: [] };
    }

    return { count: invalidKeys.length, deletedKeys: invalidKeys };
  } catch (err) {
    console.error('[Cleanup Exception]', err);
    return { count: 0, deletedKeys: [] };
  }
};

export const bulkSyncDispatchedToSupabase = async (
  dispatchedList: Array<{ key: string; date?: string; by?: string; vrm?: string; email?: string }>
): Promise<boolean> => {
  if (!dispatchedList || dispatchedList.length === 0) return true;
  const client = getSupabaseClient();
  if (!client) return false;

  try {
    const today = getTodayISO();
    const payload = dispatchedList
      .filter((item) => item && item.key && String(item.key).trim().length > 0)
      .map((item) => ({
        key: String(item.key).trim(),
        dispatch_date: item.date ? String(item.date).trim() : today,
        dispatch_by: item.by ? String(item.by).trim() : 'System User',
        vrm: item.vrm ? String(item.vrm).trim() : null,
        email: item.email ? String(item.email).trim() : null
      }));

    if (payload.length === 0) return true;

    const BATCH_SIZE = 400;
    for (let i = 0; i < payload.length; i += BATCH_SIZE) {
      const chunk = payload.slice(i, i + BATCH_SIZE);
      const { error } = await client.from('dispatched_history').upsert(chunk, { onConflict: 'key' });
      if (error) {
        const basicChunk = chunk.map((c) => ({
          key: c.key,
          dispatch_date: c.dispatch_date,
          dispatch_by: c.dispatch_by
        }));
        const { error: basicErr } = await client.from('dispatched_history').upsert(basicChunk, { onConflict: 'key' });
        if (basicErr) {
          return false;
        }
      }
    }

    return true;
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

  const client = getSupabaseClient();
  if (!client) {
    return { success: false, error: 'Supabase not configured' };
  }

  const cleanKey = String(key).trim();
  const dateVal = date || getTodayISO();
  const byVal = by || 'System User';
  const cleanVrm = vrm ? String(vrm).trim() : null;
  const cleanEmail = email ? String(email).trim() : null;

  try {
    let written = false;
    try {
      const { error: rpcErr } = await client.rpc('log_dispatch', {
        p_key: cleanKey,
        p_dispatch_date: dateVal,
        p_dispatch_by: byVal,
        p_vrm: cleanVrm,
        p_email: cleanEmail
      });
      if (!rpcErr) {
        written = true;
      }
    } catch {}

    if (!written) {
      const payload = {
        key: cleanKey,
        dispatch_date: dateVal,
        dispatch_by: byVal,
        vrm: cleanVrm,
        email: cleanEmail
      };

      let { error } = await client.from('dispatched_history').upsert(payload, { onConflict: 'key' });
      if (error) {
        const basicPayload = { key: cleanKey, dispatch_date: dateVal, dispatch_by: byVal };
        const retry = await client.from('dispatched_history').upsert(basicPayload, { onConflict: 'key' });
        error = retry.error;
      }
      if (error) {
        return {
          success: false,
          error: error.message || 'Failed to write dispatch status',
          isRlsError: error.code === '42501'
        };
      }
    }

    return { success: true };
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

  const client = getSupabaseClient();
  if (!client) return false;

  try {
    const { error } = await client.from('dispatched_history').delete().in('key', cleanKeys);
    if (error) {
      console.warn('Failed to delete dispatched keys from Supabase:', error.message);
      return false;
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
    const { error } = await client.from('dispatched_history').delete().neq('key', '___non_existent___');
    if (error) return false;
    return true;
  } catch (err) {
    console.warn('Failed to clear dispatched in Supabase:', err);
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