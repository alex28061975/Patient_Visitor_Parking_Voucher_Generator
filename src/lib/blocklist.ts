import { safeLocalStorage } from "../utils/safeLocalStorage";
import { apiFetch } from "./apiClient";

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

export async function hydrateBlocklistFromServer(): Promise<BlocklistItem[] | null> {
  if (typeof fetch === "undefined") {
    recordBlocklistSyncFailure("Network unavailable in current environment");
    return null;
  }
  try {
    const res = await apiFetch("/api/blocklist");
    if (!res || !res.ok) {
      const errBody = res ? await res.json().catch(() => null) : null;
      const errMsg = errBody?.error || `HTTP ${res?.status ?? "unknown"}`;
      console.warn("Failed to hydrate blocklist from server:", errMsg);
      recordBlocklistSyncFailure(errMsg);
      return null;
    }
    const data = await res.json().catch(() => null);
    if (data && Array.isArray(data.blocklist)) {
      recordBlocklistSyncSuccess();
      return writeLocalBlocklist(data.blocklist);
    }
    recordBlocklistSyncFailure("Invalid blocklist response from server");
    return null;
  } catch (e: any) {
    const errMsg = e?.message || "Network request failed";
    console.warn("Failed to hydrate blocklist from server:", e);
    recordBlocklistSyncFailure(errMsg);
    return null;
  }
}

export async function saveBlocklist(items: BlocklistItem[]): Promise<BlocklistItem[]> {
  const normalized = normalizeSeedList([...items]);

  if (typeof fetch === "undefined") {
    const errMsg = "Network unavailable: cannot sync blocklist with central server";
    recordBlocklistSyncFailure(errMsg);
    throw new Error(errMsg);
  }

  let res: Response;
  try {
    res = await apiFetch("/api/blocklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: normalized })
    });
  } catch (err: any) {
    const errMsg = err?.message || "Failed to sync blocklist with central server";
    recordBlocklistSyncFailure(errMsg);
    throw err;
  }

  if (!res.ok) {
    const errData = await res.json().catch(() => null);
    const errMsg = errData?.error || `Failed to save blocklist (HTTP ${res.status})`;
    recordBlocklistSyncFailure(errMsg);
    throw new Error(errMsg);
  }

  const data = await res.json().catch(() => null);
  const authoritative = data && Array.isArray(data.blocklist) ? data.blocklist : normalized;
  recordBlocklistSyncSuccess();
  return writeLocalBlocklist(authoritative);
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

