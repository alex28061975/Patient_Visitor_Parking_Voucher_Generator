import { CsvPermitRecord, getTodayISO, parseDateToISO } from "./csvParser";
import { getSupabaseClient, syncDispatchedToSupabase, deleteDispatchedFromSupabase, deleteDispatchedKeysFromSupabase, fetchDispatchedFromSupabase } from "../lib/supabase";
import { safeLocalStorage } from "./safeLocalStorage";

/**
 * Helper to compute a simple 32-bit FNV-1a hash string for deterministic fallback key generation
 */
function hashString(str: string): string {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Returns the strictly unique primary key for a permit record.
 * Uses record.formId || record.id. If missing, computes a deterministic fallback key
 * based on stable record properties without mutating the input record object.
 * DO NOT use VRM alone for dispatch state checking.
 */
export function getRecordPrimaryKey(
  record?: CsvPermitRecord | null,
  fallbackVrm?: string | null,
  fallbackDate?: string | null
): string {
  if (!record) return "";

  if (record.formId !== undefined && record.formId !== null && String(record.formId).trim() !== "") {
    return String(record.formId).trim();
  }

  if (record.id !== undefined && record.id !== null && String(record.id).trim() !== "") {
    return String(record.id).trim();
  }

  // Generate a deterministic fallback key based on stable properties without mutating the input object
  const vrm = (record.vrm || fallbackVrm || "").toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const email = (record.email || record.driverEmail || "").toString().trim().toLowerCase();
  const dateRequired = (record.dateRequired || record.validFrom || record.todayDate || fallbackDate || "").toString().trim();
  const driverName = (record.driverName || record.name || "").toString().trim().toLowerCase();

  const stableSeed = `${vrm}_${email}_${dateRequired}_${driverName}`;
  if (stableSeed.replace(/_/g, "").length > 0) {
    return `rec_${hashString(stableSeed)}`;
  }

  return "";
}

/**
 * Resolves all strict Form ID key aliases for a permit record.
 * STRICTLY ISOLATED TO FORM ID / RECORD ID ONLY — NEVER MATCHES BY VRM ALONE.
 */
export function getRecordKeys(
  record?: CsvPermitRecord | null,
  _vrm?: string | null,
  _name?: string | null,
  _dateRequired?: string | null
): string[] {
  if (!record) return [];

  const keys = new Set<string>();
  const add = (k?: string | number | null) => {
    if (k === undefined || k === null) return;
    const str = String(k).trim();
    if (str) keys.add(str);
  };

  const pk = getRecordPrimaryKey(record);
  if (pk) {
    add(pk);
    const cleanNum = pk.replace(/[^0-9]/g, "");
    if (cleanNum) {
      add(cleanNum);
      add(`FORM_${cleanNum}`);
    }
  }

  if (record.id) {
    const idStr = String(record.id).trim();
    add(idStr);
    const cleanNum = idStr.replace(/[^0-9]/g, "");
    if (cleanNum) {
      add(cleanNum);
      add(`FORM_${cleanNum}`);
    }
  }

  if (record.formId) {
    const formIdStr = String(record.formId).trim();
    add(formIdStr);
    const cleanNum = formIdStr.replace(/[^0-9]/g, "");
    if (cleanNum) {
      add(cleanNum);
      add(`FORM_${cleanNum}`);
    }
  }

  return Array.from(keys);
}

/**
 * Gets the PRIMARY dispatch key for a record (Form ID based).
 * Strictly returns the unique Form ID primary key.
 */
export function getPrimaryDispatchKey(
  record?: CsvPermitRecord | any | null,
  fallbackVrm?: string | null,
  fallbackDate?: string | null
): string {
  return getRecordPrimaryKey(record, fallbackVrm, fallbackDate);
}

/**
 * Synchronously check if a record is dispatched by checking against pre-fetched dispatched Form IDs
 * and unsent keys from Supabase dispatch logs.
 *
 * Strict One-by-One Derivation: Returns true ONLY if a Form ID key specific to this record exists in dispatchedKeys.
 */
export function checkIsRecordDispatched(
  record?: CsvPermitRecord | any | null,
  _vrm?: string | null,
  _name?: string | null,
  _dateRequired?: string | null,
  dispatchedKeys?: string[] | Set<string>,
  unsentKeys?: string[] | Set<string>
): boolean {
  if (!record) return false;

  const recordKeys = getRecordKeys(record);
  if (recordKeys.length === 0) return false;

  const dispatchedSet = dispatchedKeys
    ? (Array.isArray(dispatchedKeys) ? new Set(dispatchedKeys) : dispatchedKeys)
    : new Set<string>();

  const unsentSet = unsentKeys
    ? (Array.isArray(unsentKeys) ? new Set(unsentKeys) : unsentKeys)
    : null;

  // If explicitly unmarked as dispatched / marked unsent in current session
  if (unsentSet && unsentSet.size > 0) {
    for (const k of recordKeys) {
      if (unsentSet.has(k)) {
        return false;
      }
    }
  }

  // Check if any resolved Form ID key alias for this specific record exists in dispatchedSet
  if (dispatchedSet.size > 0) {
    for (const k of recordKeys) {
      if (dispatchedSet.has(k)) {
        return true;
      }
    }
  }

  // Default: unrecorded records are strictly Pending (false)
  return false;
}

/**
 * Async check if a record is dispatched by querying Supabase directly by Form ID
 */
export async function checkIsRecordDispatchedAsync(
  record?: CsvPermitRecord | null
): Promise<boolean> {
  if (!record) return false;

  const primaryKey = getRecordPrimaryKey(record);
  if (!primaryKey) return false;

  const client = getSupabaseClient();
  if (!client) {
    console.warn('Supabase client not available');
    return false;
  }

  try {
    const recordKeys = getRecordKeys(record);
    const { data, error } = await client
      .from('dispatched_history')
      .select('key')
      .in('key', recordKeys)
      .limit(1);

    if (error) {
      console.error('Error checking dispatch status in Supabase:', error);
      return false;
    }

    return Array.isArray(data) && data.length > 0;
  } catch (error) {
    console.error('Error checking dispatch status:', error);
    return false;
  }
}

/**
 * Alias for backward compatibility
 */
export const checkIsRecordDispatchedSync = checkIsRecordDispatched;

/**
 * Batch check dispatch status for multiple records by Form ID
 */
export async function batchCheckIsRecordDispatched(
  records: CsvPermitRecord[]
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();

  if (!records || records.length === 0) return result;

  const allKeysToQuery: string[] = [];
  const keyToRecordPk = new Map<string, string>();

  for (const record of records) {
    const pk = getRecordPrimaryKey(record);
    if (pk) {
      result.set(pk, false);
      const keys = getRecordKeys(record);
      for (const k of keys) {
        allKeysToQuery.push(k);
        keyToRecordPk.set(k, pk);
      }
    }
  }

  if (allKeysToQuery.length === 0) return result;

  const client = getSupabaseClient();
  if (!client) {
    return result;
  }

  try {
    const { data, error } = await client
      .from('dispatched_history')
      .select('key')
      .in('key', allKeysToQuery);

    if (error) {
      console.error('Error batch checking dispatch status:', error);
      return result;
    }

    if (data && Array.isArray(data)) {
      for (const item of data) {
        const pk = keyToRecordPk.get(item.key) || item.key;
        result.set(pk, true);
      }
    }

    return result;
  } catch (error) {
    console.error('Error batch checking dispatch status:', error);
    return result;
  }
}

/**
 * Mark a record as dispatched in Supabase by strict Form ID
 */
export async function markRecordAsDispatched(
  record: CsvPermitRecord,
  dispatchedBy?: string,
  _notes?: string
): Promise<{ success: boolean; error?: string; isRlsError?: boolean }> {
  const primaryKey = getRecordPrimaryKey(record);
  if (!primaryKey) {
    return { success: false, error: 'Could not generate dispatch key from record Form ID' };
  }

  const client = getSupabaseClient();
  if (!client) {
    return { success: false, error: 'Supabase client not available' };
  }

  const todayISO = getTodayISO();
  const dispatchedByName = dispatchedBy || 'System User';

  try {
    // Single consolidated write per send action using the primary Form ID dispatch key
    const syncRes = await syncDispatchedToSupabase(
      primaryKey,
      todayISO,
      dispatchedByName,
      record.vrm,
      record.email
    );

    if (!syncRes.success) {
      return {
        success: false,
        error: syncRes.error || 'Failed to write dispatch status to database',
        isRlsError: syncRes.isRlsError
      };
    }

    return { success: true };
  } catch (error: any) {
    console.error('Error marking record as dispatched:', error);
    return { success: false, error: error.message || 'Unknown database error' };
  }
}

/**
 * Unmark a record as dispatched (remove from Supabase by Form ID)
 */
export async function unmarkRecordAsDispatched(
  record: CsvPermitRecord
): Promise<{ success: boolean; error?: string }> {
  const primaryKey = getRecordPrimaryKey(record);
  if (!primaryKey) {
    return { success: false, error: 'Could not generate dispatch key from record Form ID' };
  }

  const client = getSupabaseClient();
  if (!client) {
    return { success: false, error: 'Supabase client not available' };
  }

  try {
    const allKeys = getRecordKeys(record);
    const keysToDelete = Array.from(new Set([primaryKey, ...allKeys]));
    await deleteDispatchedKeysFromSupabase(keysToDelete);

    return { success: true };
  } catch (error: any) {
    console.error('Error unmarking record as dispatched:', error);
    return { success: false, error: error.message || 'Unknown database error' };
  }
}

/**
 * Fetch dispatched Form IDs directly from Supabase (Source of Truth)
 */
export async function fetchDispatchedFormIdsFromSupabase(): Promise<{
  dispatchedKeys: string[];
  dispatchDates: Record<string, string>;
  dispatchBy: Record<string, string>;
} | null> {
  return fetchDispatchedFromSupabase();
}

/**
 * Get all dispatched keys from Supabase (for initial load)
 */
export async function getAllDispatchedKeys(): Promise<string[]> {
  const client = getSupabaseClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('dispatched_history')
      .select('key');

    if (error) throw error;
    return data?.map(item => item.key) || [];
  } catch (error) {
    console.error('Error getting all dispatched keys:', error);
    return [];
  }
}

/**
 * Get dispatch history for a record by Form ID
 */
export async function getRecordDispatchHistory(
  record: CsvPermitRecord
): Promise<any[]> {
  const primaryKey = getRecordPrimaryKey(record);
  if (!primaryKey) return [];

  const client = getSupabaseClient();
  if (!client) return [];

  try {
    const allKeys = getRecordKeys(record);
    const { data, error } = await client
      .from('dispatched_history')
      .select('key, dispatch_date, dispatch_by, vrm, email')
      .in('key', allKeys);

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error getting dispatch history:', error);
    return [];
  }
}

/**
 * Checks if a VRM is a placeholder or unassigned string
 */
export function isPlaceholderVrm(vrm?: string | null): boolean {
  if (!vrm) return true;
  const clean = String(vrm).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!clean || clean.length < 2) return true;
  return (
    clean === "PENDING" ||
    clean === "NONE" ||
    clean === "NULL" ||
    clean === "UNDEFINED" ||
    clean === "NA" ||
    clean === "UNKNOWN" ||
    clean === "TBC" ||
    clean === "EMPTY" ||
    clean === "NOTSET" ||
    clean === "DEFAULT"
  );
}

/**
 * Extracts a normalized, canonical permit key from id or formId, stripping '#' prefixes
 */
export function getNormalizedPermitKey(record: any): string {
  if (!record) return "";
  const clean = (v: any): string => {
    if (v === undefined || v === null) return "";
    const s = String(v).trim().replace(/^#/, "");
    if (!s || s === "-" || s.toLowerCase() === "undefined" || s.toLowerCase() === "null") return "";
    return s;
  };
  const formId = clean(record.formId);
  const id = clean(record.id);
  if (formId && !formId.startsWith("row-")) return formId;
  if (id && !id.startsWith("row-")) return id;
  return formId || id;
}

/**
 * Checks if two permit records or record-like objects match by Form ID, ID, or VRM + Date
 */
export function isRecordMatch(r1?: any, r2?: any): boolean {
  if (!r1 || !r2) return false;
  if (r1 === r2) return true;

  const clean = (v: any): string => {
    if (v === undefined || v === null) return "";
    const s = String(v).trim().replace(/^#/, "");
    if (!s || s === "-" || s.toLowerCase() === "undefined" || s.toLowerCase() === "null") return "";
    return s;
  };

  const id1 = clean(r1.id);
  const formId1 = clean(r1.formId);
  const id2 = clean(r2.id);
  const formId2 = clean(r2.formId);

  const hasId1 = Boolean(id1 || formId1);
  const hasId2 = Boolean(id2 || formId2);

  // If BOTH records have an ID or Form ID, they MUST match on ID.
  // If their IDs do not match, they are definitely DIFFERENT records.
  // Under NO circumstances should they fall through to VRM matching!
  if (hasId1 && hasId2) {
    return Boolean(
      (id1 && id2 && id1 === id2) ||
      (formId1 && formId2 && formId1 === formId2) ||
      (id1 && formId2 && id1 === formId2) ||
      (formId1 && id2 && formId1 === id2)
    );
  }

  // If one or both records lack an ID (e.g. comparing with a form input),
  // match ONLY if both have a valid, non-placeholder VRM and matching dates.
  const vrm1 = String(r1.vrm || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const vrm2 = String(r2.vrm || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  if (isPlaceholderVrm(vrm1) || isPlaceholderVrm(vrm2)) {
    return false;
  }

  if (vrm1 === vrm2) {
    const d1 = parseDateToISO(r1.validFrom || r1.dateRequired || r1.todayDate) || "";
    const d2 = parseDateToISO(r2.validFrom || r2.dateRequired || r2.todayDate) || "";
    if (d1 && d2 && d1 === d2) return true;
  }

  return false;
}

/**
 * Tests whether dispatched_history table is currently accepting writes from the anon client
 */
export async function testDispatchedHistoryWrite(): Promise<{ writable: boolean; isRlsError?: boolean; error?: string }> {
  const client = getSupabaseClient();
  if (!client) return { writable: false, error: 'Supabase client not configured' };

  try {
    const probeKey = '___rls_probe_ping___';
    const { error: insErr } = await client.from('dispatched_history').upsert({
      key: probeKey,
      dispatch_date: getTodayISO(),
      dispatch_by: 'Probe Ping'
    }, { onConflict: 'key' });

    if (insErr) {
      // Test if RPC log_dispatch function works (SECURITY DEFINER)
      try {
        const { error: rpcErr } = await client.rpc('log_dispatch', {
          p_key: probeKey,
          p_dispatch_date: getTodayISO(),
          p_dispatch_by: 'Probe Ping'
        });
        if (!rpcErr) {
          await client.from('dispatched_history').delete().eq('key', probeKey);
          return { writable: true };
        }
      } catch (e) {}

      const isRls = insErr.code === '42501' || insErr.message?.toLowerCase().includes('row-level security') || insErr.message?.toLowerCase().includes('violates');
      return { writable: false, isRlsError: isRls, error: insErr.message };
    }

    // Clean up probe record immediately
    await client.from('dispatched_history').delete().eq('key', probeKey);
    return { writable: true };
  } catch (err: any) {
    return { writable: false, error: err?.message };
  }
}

/**
 * Gets count of dispatches waiting in the pending queue
 */
export function getPendingDispatchesCount(): number {
  try {
    const raw = safeLocalStorage.getItem("concessions_pending_dispatches");
    if (!raw) return 0;
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Syncs any pending locally-saved dispatches to Supabase
 */
export async function syncPendingDispatches(): Promise<{ synced: number; remaining: number; rlsBlocked?: boolean }> {
  try {
    const raw = safeLocalStorage.getItem("concessions_pending_dispatches");
    if (!raw) return { synced: 0, remaining: 0 };
    const list: Array<{ key: string; date: string; by: string; vrm?: string; email?: string }> = JSON.parse(raw);
    if (!Array.isArray(list) || list.length === 0) return { synced: 0, remaining: 0 };

    const remaining: typeof list = [];
    let synced = 0;
    let rlsBlocked = false;

    for (const item of list) {
      if (rlsBlocked) {
        remaining.push(item);
        continue;
      }
      const res = await syncDispatchedToSupabase(item.key, item.date, item.by, item.vrm, item.email);
      if (res.success) {
        synced++;
      } else {
        remaining.push(item);
        if (res.isRlsError) {
          rlsBlocked = true;
        }
      }
    }

    if (remaining.length > 0) {
      safeLocalStorage.setItem("concessions_pending_dispatches", JSON.stringify(remaining));
    } else {
      safeLocalStorage.removeItem("concessions_pending_dispatches");
    }

    return { synced, remaining: remaining.length, rlsBlocked };
  } catch (err) {
    console.error("Error syncing pending dispatches:", err);
    return { synced: 0, remaining: 0 };
  }
}
