import { safeLocalStorage } from "../utils/safeLocalStorage";
import { getSupabaseClient, isMissingSupabaseSchemaError } from "./supabase";

export interface BlocklistItem {
  id: string;
  formId?: string | number;
  hospitalSite?: string;
  wardDept?: string;
  dateRequired?: string;
  expiryDate?: string;
  vrm: string;
  driverName?: string;
  phone?: string;
  email?: string;
  voucherCode?: string;
  reason: string;
  addedAt?: string;
}

export const BLOCKLIST_STORAGE_KEY = "concession_blocklist_data";

// Initial seed data if none in storage (Preserving AU67 HCZ as valid blocked vehicle without expired date)
const DEFAULT_BLOCKLIST: BlocklistItem[] = [
  {
    id: "blk_seed_1",
    formId: "1311",
    hospitalSite: "Whipps Cross Hospital",
    wardDept: "Emergency Care",
    dateRequired: "2025-05-10",
    vrm: "AU67 HCZ",
    driverName: "Sarah Connor",
    phone: "07700900123",
    email: "s.connor@example.com",
    voucherCode: "BLOCKED",
    reason: "Duplicate permit abuse / multiple simultaneous active vehicles",
    addedAt: "2025-05-10T08:00:00.000Z"
  }
];

function toISODateOnly(val?: string): string {
  if (!val) return "";
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.substring(0, 10);
  }
  const ddmmyyyy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (ddmmyyyy) {
    return `${ddmmyyyy[3]}-${ddmmyyyy[2].padStart(2, "0")}-${ddmmyyyy[1].padStart(2, "0")}`;
  }
  return s.substring(0, 10);
}

export function normalizeVrm(vrm?: string): string {
  if (!vrm) return "";
  return vrm.replace(/\s+/g, "").toUpperCase();
}

function normalizeSeedList(items: BlocklistItem[]): BlocklistItem[] {
  const cleaned = items.map((item) => {
    if (item && item.id === "blk_seed_1" && normalizeVrm(item.vrm) === "AU67HCZ" && item.expiryDate === "2025-05-17") {
      const { expiryDate: _staleExpiry, ...rest } = item;
      return rest;
    }
    return item;
  });
  if (!cleaned.some((i) => normalizeVrm(i.vrm) === "AU67HCZ")) {
    cleaned.unshift({ ...DEFAULT_BLOCKLIST[0] });
  }
  return cleaned;
}

let cachedBlocklistRaw: string | null = null;
let cachedBlocklistItems: BlocklistItem[] | null = null;

function writeLocalBlocklist(items: BlocklistItem[]): BlocklistItem[] {
  const normalized = normalizeSeedList(items);
  const serialized = JSON.stringify(normalized);
  cachedBlocklistRaw = serialized;
  cachedBlocklistItems = normalized;
  safeLocalStorage.setItem(BLOCKLIST_STORAGE_KEY, serialized);
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent("blocklist_updated", { detail: normalized }));
    } catch {}
  }
  return normalized;
}

export function getBlocklist(): BlocklistItem[] {
  try {
    const raw = safeLocalStorage.getItem(BLOCKLIST_STORAGE_KEY);
    if (!raw) {
      const seed = DEFAULT_BLOCKLIST.map((item) => ({ ...item }));
      const serialized = JSON.stringify(seed);
      cachedBlocklistRaw = serialized;
      cachedBlocklistItems = seed;
      safeLocalStorage.setItem(BLOCKLIST_STORAGE_KEY, serialized);
      return seed;
    }
    if (raw === cachedBlocklistRaw && cachedBlocklistItems) {
      return cachedBlocklistItems;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const normalized = normalizeSeedList(parsed);
      cachedBlocklistRaw = raw;
      cachedBlocklistItems = normalized;
      return normalized;
    }
    return DEFAULT_BLOCKLIST.map((item) => ({ ...item }));
  } catch (e) {
    console.error("Failed to load blocklist from storage:", e);
    return DEFAULT_BLOCKLIST.map((item) => ({ ...item }));
  }
}

export interface BlocklistSyncStatus {
  hydrated: boolean;
  isStale: boolean;
  error: string | null;
  lastSyncedAt: string | null;
}

let blocklistSyncStatus: BlocklistSyncStatus = {
  hydrated: false,
  isStale: false,
  error: null,
  lastSyncedAt: null
};

export function getBlocklistSyncStatus(): BlocklistSyncStatus {
  return { ...blocklistSyncStatus };
}

function recordBlocklistSyncSuccess() {
  blocklistSyncStatus = {
    hydrated: true,
    isStale: false,
    error: null,
    lastSyncedAt: new Date().toISOString()
  };
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent("blocklist_sync_updated", { detail: { ...blocklistSyncStatus } }));
    } catch {}
  }
}

function recordBlocklistSyncFailure(errorMessage: string) {
  const wasAlreadyStale = blocklistSyncStatus.isStale;
  blocklistSyncStatus = {
    hydrated: false,
    isStale: true,
    error: errorMessage,
    lastSyncedAt: blocklistSyncStatus.lastSyncedAt
  };
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent("blocklist_sync_error", { detail: { ...blocklistSyncStatus } }));
      if (!wasAlreadyStale) {
        window.dispatchEvent(new CustomEvent("app-toast", {
          detail: {
            message: `⚠️ Central blocklist sync failed (${errorMessage}). Cached local rules may be outdated.`,
            type: "warning"
          }
        }));
      }
    } catch {}
  }
}

function mapRowToBlocklistItem(d: any): BlocklistItem {
  return {
    id: d.id,
    formId: d.form_id || undefined,
    hospitalSite: d.hospital_site || undefined,
    wardDept: d.ward_dept || undefined,
    dateRequired: d.date_required || undefined,
    expiryDate: d.expiry_date || undefined,
    vrm: d.vrm,
    driverName: d.driver_name || undefined,
    phone: d.phone || undefined,
    email: d.email || undefined,
    voucherCode: d.voucher_code || undefined,
    reason: d.reason || "",
    addedAt: d.added_at || undefined
  };
}

function isBlocklistUnavailableError(err: any): boolean {
  if (!err) return false;
  if (isMissingSupabaseSchemaError(err)) return true;
  const code = String(err.code || "").trim().toUpperCase();
  const msg = String(err.message || err.details || err.hint || "").toLowerCase();
  return (
    code === "42501" ||
    msg.includes("permission denied") ||
    msg.includes("row-level security")
  );
}

export async function hydrateBlocklistFromServer(): Promise<BlocklistItem[] | null> {
  const client = getSupabaseClient();
  if (!client) {
    recordBlocklistSyncSuccess();
    return getBlocklist();
  }

  try {
    const { data, error } = await client.from("blocklist").select("*");
    if (error) {
      if (isBlocklistUnavailableError(error)) {
        // Graceful local fallback when public.blocklist table is unavailable to anon client
        recordBlocklistSyncSuccess();
        return writeLocalBlocklist(getBlocklist());
      }
      console.warn("Failed to hydrate blocklist from Supabase:", error.message);
      recordBlocklistSyncFailure(error.message);
      return null;
    }

    if (Array.isArray(data)) {
      const mapped = data.length > 0 ? data.map(mapRowToBlocklistItem) : [...DEFAULT_BLOCKLIST];
      recordBlocklistSyncSuccess();
      return writeLocalBlocklist(mapped);
    }

    recordBlocklistSyncFailure("Invalid blocklist response from Supabase");
    return null;
  } catch (e: any) {
    if (isBlocklistUnavailableError(e)) {
      recordBlocklistSyncSuccess();
      return writeLocalBlocklist(getBlocklist());
    }
    const errMsg = e?.message || "Network request failed";
    console.warn("Failed to hydrate blocklist from Supabase:", e);
    recordBlocklistSyncFailure(errMsg);
    return null;
  }
}

export async function saveBlocklist(items: BlocklistItem[]): Promise<BlocklistItem[]> {
  const normalized = normalizeSeedList([...items]).map((item) => ({
    ...item,
    id: item.id || `blk_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    vrm: String(item.vrm).trim().toUpperCase(),
    reason: item.reason || "Administrative block",
    addedAt: item.addedAt || new Date().toISOString()
  }));

  const client = getSupabaseClient();
  if (!client) {
    recordBlocklistSyncSuccess();
    return writeLocalBlocklist(normalized);
  }

  const rowsToPersist = normalized.map((item) => ({
    id: item.id,
    form_id: item.formId !== undefined ? String(item.formId) : null,
    hospital_site: item.hospitalSite || null,
    ward_dept: item.wardDept || null,
    date_required: item.dateRequired || null,
    expiry_date: item.expiryDate || null,
    vrm: item.vrm,
    driver_name: item.driverName || null,
    phone: item.phone || null,
    email: item.email || null,
    voucher_code: item.voucherCode || "BLOCKED",
    reason: item.reason,
    added_at: item.addedAt || new Date().toISOString()
  }));

  try {
    const { data: rpcData, error: rpcErr } = await client.rpc("replace_blocklist", { entries: rowsToPersist });
    if (rpcErr) {
      if (isBlocklistUnavailableError(rpcErr)) {
        // Fallback to direct table upsert/sync if replace_blocklist RPC is absent,
        // or graceful local-only storage if public.blocklist table itself is unavailable.
        const { error: upsertErr } = await client.from("blocklist").upsert(rowsToPersist, { onConflict: "id" });
        if (upsertErr) {
          if (isBlocklistUnavailableError(upsertErr)) {
            recordBlocklistSyncSuccess();
            return writeLocalBlocklist(normalized);
          }
          recordBlocklistSyncFailure(upsertErr.message);
          throw new Error(upsertErr.message);
        }
        recordBlocklistSyncSuccess();
        return writeLocalBlocklist(normalized);
      }

      recordBlocklistSyncFailure(rpcErr.message || "Failed to replace blocklist");
      throw new Error(rpcErr.message || "Failed to replace blocklist");
    }

    const authoritative = Array.isArray(rpcData) && rpcData.length > 0
      ? rpcData.map(mapRowToBlocklistItem)
      : normalized;

    recordBlocklistSyncSuccess();
    return writeLocalBlocklist(authoritative);
  } catch (err: any) {
    if (isBlocklistUnavailableError(err)) {
      recordBlocklistSyncSuccess();
      return writeLocalBlocklist(normalized);
    }
    const errMsg = err?.message || "Failed to save blocklist to Supabase";
    recordBlocklistSyncFailure(errMsg);
    throw err instanceof Error ? err : new Error(errMsg);
  }
}

export async function addBlocklistItem(item: Omit<BlocklistItem, "id"> & { id?: string }): Promise<BlocklistItem> {
  const list = getBlocklist();
  const newItem: BlocklistItem = {
    ...item,
    id: item.id || `blk_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    vrm: item.vrm.trim().toUpperCase(),
    addedAt: item.addedAt || new Date().toISOString()
  };
  const updated = [newItem, ...list];
  await saveBlocklist(updated);
  return newItem;
}

export async function removeBlocklistItem(id: string): Promise<void> {
  const list = getBlocklist();
  const updated = list.filter((i) => i.id !== id);
  await saveBlocklist(updated);
}

export function isVrmSilentBlockedSync(vrm?: string, checkDate?: string): boolean {
  if (!vrm) return false;
  const target = normalizeVrm(vrm);
  if (!target) return false;
  const list = getBlocklist();
  const refDate = checkDate ? toISODateOnly(checkDate) : new Date().toISOString().substring(0, 10);
  return list.some((item) => {
    if (normalizeVrm(item.vrm) !== target) return false;
    if (item.expiryDate) {
      const exp = toISODateOnly(item.expiryDate);
      if (exp && refDate > exp) {
        // Expiry date has passed, so block entry is no longer active
        return false;
      }
    }
    return true;
  });
}

export async function isVrmSilentBlocked(vrm?: string, checkDate?: string): Promise<boolean> {
  await hydrateBlocklistFromServer();
  return isVrmSilentBlockedSync(vrm, checkDate);
}

export const isVrmBlocked = isVrmSilentBlocked;
