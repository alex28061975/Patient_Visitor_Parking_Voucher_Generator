import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { PermitData, StorageMode } from "./types";
import { CheckCircle2, AlertCircle, Info, CloudUpload, X } from "lucide-react";
import { Header } from "./components/Header";
import { PermitCard } from "./components/PermitCard";
import type { PermitCardHandle } from "./components/PermitCard";
import { DispatchCentre } from "./components/DispatchCentre";
import { RefreshCw, Sparkles, Database } from "lucide-react";
import { safeLocalStorage } from "./utils/safeLocalStorage";
import { isMobileDevice } from "./utils/device";
import { 
  getRecordKeys, 
  getRecordPrimaryKey,
  getPrimaryDispatchKey, 
  checkIsRecordDispatched,
  markRecordAsDispatched,
  unmarkRecordAsDispatched,
  getAllDispatchedKeys,
  batchCheckIsRecordDispatched,
  isRecordMatch,
  isPlaceholderVrm,
  getNormalizedPermitKey
} from "./utils/dispatchUtils";

// CSV Database Imports
import { INITIAL_DEMO_CSV } from "./data/defaultCsv";
import { isVrmSilentBlockedSync } from "./lib/blocklist";
import { CsvPermitRecord, parsePermitCsv, parseDateToISO, addDays, formatPhoneNumber, ParsedVoucherData, addDaysSafe, parseDateRange, getDatesInRange, cleanVoucherCodeValue, exportToExcel, isVoucherCodeMatch, sortRecordsByFormIdDesc, getMatchingPermits, isDateRequiredOutsideValidWindow, isPermitExpiredBackdate, getTodayISO, checkIsBlockedDuplicate, parseFullDateTimeMs, normalizeVouchersList, isRecordCancelled, getRequestedPermitDateISO, isVoucherExactPeriodEligible, isVoucherAvailableStatus, isVoucherVrmCompatible, clearDuplicateCheckCache, extractRecordSubmissionTimeMs, extractRecordNumericFormId } from "./utils/csvParser";
// ⭐ FIX: Import canonical voucher validation helper
import { isVoucherForPermitDateRange, validateManualVoucherChange, getVoucherValidFromISO, getVoucherValidToISO } from "./utils/voucherValidation";
import { CsvDatabasePanel, type CsvDatabasePanelHandle } from "./components/CsvDatabasePanel";
import { BlocklistPanel } from "./components/BlocklistPanel";
import { EditRecordModal } from "./components/EditRecordModal";
import { 
  isSupabaseConfigured, 
  initSupabaseConfig,
  checkSupabaseConnection,
  fetchPermitsFromSupabase, 
  syncPermitsToSupabase, 
  updatePermitInSupabase,
  fetchVouchersFromSupabase, 
  syncVouchersToSupabase, 
  fetchDispatchedFromSupabase, 
  syncDispatchedToSupabase, 
  bulkSyncDispatchedToSupabase,
  deleteDispatchedFromSupabase,
  clearSupabaseDispatches,
  cleanupCorruptedDispatchedKeys,
  subscribeToSupabaseChanges,
  clearInvalidVoucherCodes,
  resetVoucherInventory,
  clearAllVouchers
} from "./lib/supabase";

export interface EmailTrackingInfo {
  status: "SENT" | string;
  sentAt?: string;
  openedAt?: string;
  openCount?: number;
  trackingId?: string;
}

// Helper to format string to Title Case (capitalize each word)
function toTitleCase(str: string): string {
  if (!str || str === "-") return str;
  return str
    .toLowerCase()
    .replace(/(?:^|\s|-)\S/g, (char) => char.toUpperCase());
}

// ⭐ Auto-Cancel Duplicates - GROUP BY VRM ONLY, earliest submission timestamp wins
export const autoCancelDuplicates = (records: CsvPermitRecord[]): CsvPermitRecord[] => {
  if (!records || records.length === 0) return records;

  const results: CsvPermitRecord[] = new Array(records.length);
  const vrmMap = new Map<string, { record: CsvPermitRecord; index: number }[]>();

  // ⭐ Group by VRM ONLY.
  // CRITICAL: Do NOT blindly skip records where status === "CANCELLED" or isCancelled === true.
  // An earlier valid record might have been incorrectly marked CANCELLED by previous duplicate logic.
  // ONLY skip records with no VRM, records on the blocklist, or records outside the valid date window.
  records.forEach((record, index) => {
    const vrmKey = record.vrm?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "";

    // If no VRM, keep as-is
    if (!vrmKey || vrmKey === "PENDING" || vrmKey === "-") {
      results[index] = record;
      return;
    }

    // Records on the blocklist can never be active concession winners
    if (isVrmSilentBlockedSync(record.vrm) || String(record.status || "").trim().toUpperCase() === "BLOCKED" || record.cancellationReason === "BLOCKLIST") {
      results[index] = record;
      return;
    }

    // Expired requests backdated by 7+ days or 7+ days past the applicable reference date must be cancelled
    const rawRefDate = record.todayDate || record.processingDate || record.submissionDate;
    const refDate = rawRefDate ? (parseDateToISO(String(rawRefDate)) || "") : "";
    const isBackdateExpired = isPermitExpiredBackdate(record, refDate);
    const dateRequired = record.dateRequired || record.validFrom || "";
    const reqIsoVal = parseDateToISO(dateRequired);
    const isExpiredDate = refDate && reqIsoVal && Math.floor((new Date(reqIsoVal + "T00:00:00").getTime() - new Date(refDate + "T00:00:00").getTime()) / 86400000) <= -7;
    const isExpired = isBackdateExpired || Boolean(isExpiredDate) || (record.cancellationReason === "EXPIRED" && (!record.vrm || record.vrm === "PENDING" || record.vrm === "-"));

    if (isExpired) {
      const preservedVoucher = (record.originalVoucherCode && record.originalVoucherCode !== "CANCELLED" && record.originalVoucherCode !== "-")
        ? record.originalVoucherCode
        : (record.voucherCode && record.voucherCode !== "CANCELLED" && record.voucherCode !== "-")
          ? record.voucherCode
          : undefined;

      results[index] = {
        ...record,
        isCancelled: true,
        status: "CANCELLED",
        cancellationReason: "EXPIRED",
        voucherCode: "CANCELLED",
        prePaidCode: "CANCELLED",
        originalVoucherCode: preservedVoucher || record.originalVoucherCode
      };
      return;
    }

    if (!vrmMap.has(vrmKey)) vrmMap.set(vrmKey, []);
    vrmMap.get(vrmKey)!.push({ record, index });
  });

  const getReqDateISO = (r: CsvPermitRecord): string =>
    getRequestedPermitDateISO(r) || parseDateToISO(String(r.dateRequired || r.validFrom || "")) || "";

  const getRecordSortTimeMs = (r: CsvPermitRecord): number => {
    const timeMs = extractRecordSubmissionTimeMs(r);
    if (timeMs > 0) return timeMs;
    const formIdNum = extractRecordNumericFormId(r);
    if (formIdNum > 0) return formIdNum;
    return parseFullDateTimeMs(r.startTime || r.createdAt || r.completionTime, getReqDateISO(r)) ?? 0;
  };

  const isGenuinelyCancelled = (r: CsvPermitRecord): boolean => {
    if (r.cancellationReason === "MANUAL") return true;
    if (r.cancellationReason === "BLOCKLIST") return true;
    if (r.cancellationReason === "FUTURE") return true;
    if (isVrmSilentBlockedSync(r.vrm) || String(r.status || "").trim().toUpperCase() === "BLOCKED") return true;

    const rawRefDate = r.todayDate || r.processingDate || r.submissionDate;
    const refDate = rawRefDate ? (parseDateToISO(String(rawRefDate)) || "") : "";
    if (isPermitExpiredBackdate(r, refDate)) return true;
    const dateRequired = r.dateRequired || r.validFrom || "";
    const reqIsoVal = parseDateToISO(dateRequired);
    if (refDate && reqIsoVal && Math.floor((new Date(reqIsoVal + "T00:00:00").getTime() - new Date(refDate + "T00:00:00").getTime()) / 86400000) <= -7) return true;

    return false;
  };

  // For each VRM group, the EARLIEST valid request by submission/completion timestamp WINS!
  // Any request within 7 days of an earlier kept request is CANCELLED as a duplicate.
  for (const [vrm, entries] of vrmMap) {
    if (entries.length === 1) {
      const entry = entries[0];
      const genuine = isGenuinelyCancelled(entry.record);
      const wasCancelled = entry.record.isCancelled === true ||
        String(entry.record.status || "").trim().toUpperCase() === "CANCELLED" ||
        entry.record.voucherCode === "CANCELLED" ||
        entry.record.prePaidCode === "CANCELLED" ||
        entry.record.voucherCodesText === "CANCELLED";

      if (genuine) {
        const preservedVoucher = (entry.record.originalVoucherCode && entry.record.originalVoucherCode !== "CANCELLED" && entry.record.originalVoucherCode !== "-")
          ? entry.record.originalVoucherCode
          : (entry.record.voucherCode && entry.record.voucherCode !== "CANCELLED" && entry.record.voucherCode !== "-")
            ? entry.record.voucherCode
            : undefined;

        results[entry.index] = {
          ...entry.record,
          isCancelled: true,
          status: "CANCELLED",
          cancellationReason: entry.record.cancellationReason || (isPermitExpiredBackdate(entry.record) ? "EXPIRED" : "MANUAL"),
          voucherCode: "CANCELLED",
          prePaidCode: "CANCELLED",
          originalVoucherCode: preservedVoucher || entry.record.originalVoucherCode
        };
        continue;
      }

      // An earlier record is restored from CANCELLED to ACTIVE ONLY when the cancellation
      // was caused by duplicate-VRM processing. Genuinely cancelled records (MANUAL, BLOCKLIST, EXPIRED) must NEVER be automatically restored!
      if (wasCancelled && !genuine) {
        const preservedVoucher = (entry.record.originalVoucherCode && entry.record.originalVoucherCode !== "CANCELLED" && entry.record.originalVoucherCode !== "-")
          ? entry.record.originalVoucherCode
          : (entry.record.voucherCode && entry.record.voucherCode !== "CANCELLED" && entry.record.voucherCode !== "-")
            ? entry.record.voucherCode
            : undefined;

        results[entry.index] = {
          ...entry.record,
          isCancelled: false,
          status: "ACTIVE",
          voucherCode: preservedVoucher || (entry.record.voucherCode === "CANCELLED" ? "" : entry.record.voucherCode || ""),
          prePaidCode: preservedVoucher || (entry.record.prePaidCode === "CANCELLED" ? "" : entry.record.prePaidCode || ""),
          voucherCodesText: entry.record.voucherCodesText === "CANCELLED" ? (preservedVoucher || "") : (entry.record.voucherCodesText || preservedVoucher || ""),
          originalVoucherCode: preservedVoucher || entry.record.originalVoucherCode,
          cancellationReason: undefined
        };
      } else {
        results[entry.index] = entry.record;
      }
      continue;
    }

    // Process in chronological (submission) order so the EARLIEST request is kept
    const sorted = [...entries].sort((a, b) => {
      const timeA = getRecordSortTimeMs(a.record);
      const timeB = getRecordSortTimeMs(b.record);
      if (timeA !== timeB) return timeA - timeB;
      const idA = extractRecordNumericFormId(a.record);
      const idB = extractRecordNumericFormId(b.record);
      if (idA > 0 && idB > 0 && idA !== idB) return idA - idB;
      return a.index - b.index;
    });

    const kept: { reqTimeMs: number; entry: typeof entries[0] }[] = [];

    for (const entry of sorted) {
      const reqIso = getReqDateISO(entry.record);
      const reqTimeMs = reqIso ? new Date(`${reqIso}T00:00:00`).getTime() : NaN;

      const earlierKept = !isNaN(reqTimeMs)
        ? kept.find(k => {
            const reqToIso = entry.record.validTo ? parseDateToISO(entry.record.validTo) : (entry.record.dateExpiry ? parseDateToISO(entry.record.dateExpiry) : (reqIso ? addDaysSafe(reqIso, 6) : undefined));
            const kReqIso = getReqDateISO(k.entry.record);
            const kToIso = k.entry.record.validTo ? parseDateToISO(k.entry.record.validTo) : (k.entry.record.dateExpiry ? parseDateToISO(k.entry.record.dateExpiry) : (kReqIso ? addDaysSafe(kReqIso, 6) : undefined));
            if (reqIso && reqToIso && kReqIso && kToIso) {
              const startA = new Date(`${reqIso}T00:00:00`).getTime();
              const endA = new Date(`${reqToIso}T00:00:00`).getTime();
              const startB = new Date(`${kReqIso}T00:00:00`).getTime();
              const endB = new Date(`${kToIso}T00:00:00`).getTime();
              if (!isNaN(startA) && !isNaN(endA) && !isNaN(startB) && !isNaN(endB)) {
                // Rule 7: Inclusive date overlap: startA <= endB && startB <= endA
                // Rule 10: A record whose requested date range starts after the previous record's end date
                // must not be cancelled merely because the start dates are within 7 calendar days.
                return startA <= endB && startB <= endA;
              }
            }
            const diffDays = Math.round((reqTimeMs - k.reqTimeMs) / (1000 * 60 * 60 * 24));
            // Rule 8: Exactly 7 days apart is NOT an overlap.
            return Math.abs(diffDays) < 7;
          })
        : undefined;

      const preservedVoucher = (entry.record.originalVoucherCode && entry.record.originalVoucherCode !== "CANCELLED" && entry.record.originalVoucherCode !== "-")
        ? entry.record.originalVoucherCode
        : (entry.record.voucherCode && entry.record.voucherCode !== "CANCELLED" && entry.record.voucherCode !== "-")
          ? entry.record.voucherCode
          : undefined;

      if (earlierKept) {
        // DUPLICATE DETECTED
        const winner = earlierKept.entry.record;
        const duplicate = entry.record;

        const winnerVoucher = winner.voucherCode && winner.voucherCode !== "CANCELLED"
          ? winner.voucherCode
          : (winner.originalVoucherCode || "-");

        const duplicateVoucher = duplicate.voucherCode && duplicate.voucherCode !== "CANCELLED"
          ? duplicate.voucherCode
          : (duplicate.originalVoucherCode || "-");

        console.log(`${vrm}`);
        console.log(`WINNER: #${winner.formId ?? winner.id}`);
        console.log(`submitted: ${winner.startTime || winner.completionTime || "-"}`);
        console.log(`voucher: ${winnerVoucher}`);
        console.log(`DUPLICATE: #${duplicate.formId ?? duplicate.id}`);
        console.log(`submitted: ${duplicate.startTime || duplicate.completionTime || "-"}`);
        console.log(`voucher: ${duplicateVoucher}`);

        results[entry.index] = {
          ...entry.record,
          isCancelled: true,
          status: "CANCELLED",
          voucherCode: "CANCELLED",
          prePaidCode: "CANCELLED",
          originalVoucherCode: preservedVoucher || entry.record.originalVoucherCode,
          cancellationReason: (entry.record.cancellationReason === "MANUAL" || entry.record.cancellationReason === "BLOCKLIST" || entry.record.cancellationReason === "EXPIRED" || entry.record.cancellationReason === "FUTURE")
            ? entry.record.cancellationReason
            : "DUPLICATE_VRM"
        };
        continue;
      }

      const genuine = isGenuinelyCancelled(entry.record);
      if (genuine) {
        // Genuinely cancelled records (MANUAL, BLOCKLIST, EXPIRED) must NEVER be restored and do not block other records.
        results[entry.index] = {
          ...entry.record,
          isCancelled: true,
          status: "CANCELLED",
          cancellationReason: entry.record.cancellationReason || (isPermitExpiredBackdate(entry.record) ? "EXPIRED" : "MANUAL"),
          voucherCode: "CANCELLED",
          prePaidCode: "CANCELLED",
          originalVoucherCode: preservedVoucher || entry.record.originalVoucherCode
        };
        continue;
      }

      // EARLIEST VALID REQUEST (or request with no active earlier request within 7 days) - WINNER!
      // Must be active and have voucher code restored or unblocked from "CANCELLED".
      const activeRecord: CsvPermitRecord = {
        ...entry.record,
        isCancelled: false,
        status: "ACTIVE",
        voucherCode: preservedVoucher || (entry.record.voucherCode === "CANCELLED" ? "" : entry.record.voucherCode || ""),
        prePaidCode: preservedVoucher || (entry.record.prePaidCode === "CANCELLED" ? "" : entry.record.prePaidCode || ""),
        voucherCodesText: entry.record.voucherCodesText === "CANCELLED" ? (preservedVoucher || "") : (entry.record.voucherCodesText || preservedVoucher || ""),
        originalVoucherCode: preservedVoucher || entry.record.originalVoucherCode,
        cancellationReason: undefined
      };

      results[entry.index] = activeRecord;
      if (!isNaN(reqTimeMs)) {
        kept.push({ reqTimeMs, entry: { ...entry, record: activeRecord } });
      }
    }
  }

  return results;
};

// Helper to dynamically enrich database records with voucher codes from the voucher database or custom override vouchers
export function enrichRecordsWithVouchers(
  recordsList: CsvPermitRecord[],
  vouchersDb: ParsedVoucherData[],
  customVouchersMap: Record<string, string> = {},
  fallbackDateStr: string = "",
  dispatchedKeys: string[] = [],
  unsentKeys: string[] = []
): CsvPermitRecord[] {
  const assignedGlobally = new Set<string>();
  const assignedPerCustomer = new Map<string, Set<string>>();

  const getCustomerKey = (rec: CsvPermitRecord) => {
    const vrm = rec.vrm ? rec.vrm.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    if (vrm && vrm !== "PENDING") return `vrm:${vrm}`;
    if (rec.email) return `email:${rec.email.trim().toLowerCase()}`;
    return `driver:${(rec.driverName || "").trim().toUpperCase()}`;
  };

  const checkIsAssigned = (codeUpper: string, custSet: Set<string>): boolean => {
    if (!codeUpper || codeUpper === "-" || codeUpper === "CANCELLED") return false;
    const clean = cleanVoucherCodeValue(codeUpper);
    if (assignedGlobally.has(codeUpper)) return true;
    if (clean && clean !== "-" && assignedGlobally.has(clean)) return true;
    if (custSet.has(codeUpper)) return true;
    if (clean && clean !== "-" && custSet.has(clean)) return true;
    return false;
  };

  const registerCodeGlobally = (codeStr: string, custSet?: Set<string>) => {
    if (!codeStr || codeStr === "-" || codeStr === "CANCELLED") return;
    const parts = codeStr.split(/[\n,;\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    parts.forEach(p => {
      if (p !== "-" && p !== "CANCELLED") {
        assignedGlobally.add(p);
        const clean = cleanVoucherCodeValue(p);
        if (clean && clean !== "-") assignedGlobally.add(clean);
        if (custSet) {
          custSet.add(p);
          if (clean && clean !== "-") custSet.add(clean);
        }
      }
    });
  };

  const mapRecordFallback = (record: CsvPermitRecord, index: number, defaultVal: string) => {
    const cleanVrm = record.vrm ? record.vrm.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    const recDateISO = getRequestedPermitDateISO(record, fallbackDateStr);
    const keyWithDate = recDateISO ? `${cleanVrm}_${recDateISO}` : cleanVrm;
    const hasOriginalVoucher = false;

    if (isRecordCancelled(record, recDateISO || fallbackDateStr, recordsList) || isPermitExpiredBackdate(record, recDateISO || fallbackDateStr)) {
      const isBackdate = isPermitExpiredBackdate(record, recDateISO || fallbackDateStr);
      const reqIso = parseDateToISO(record.dateRequired || record.validFrom || "");
      const isExpired7Days = Boolean(fallbackDateStr && reqIso && Math.floor((new Date(reqIso + "T00:00:00").getTime() - new Date(parseDateToISO(fallbackDateStr) + "T00:00:00").getTime()) / 86400000) <= -7);
      const determinedReason = record.cancellationReason ||
        (isVrmSilentBlockedSync(record.vrm) ? "BLOCKLIST" :
        (isBackdate || isExpired7Days) ? "EXPIRED" :
        checkIsBlockedDuplicate(record, recordsList, recDateISO || fallbackDateStr) ? "DUPLICATE_VRM" :
        "MANUAL");

      return {
        ...record,
        status: "CANCELLED",
        isCancelled: true,
        cancellationReason: determinedReason,
        voucherCode: "CANCELLED",
        prePaidCode: "CANCELLED",
        hasOriginalVoucher: false
      };
    }

    let code = "";
    const hasStableId = Boolean(
      (record.formId !== undefined && record.formId !== null && String(record.formId).trim() !== "") ||
      (record.id !== undefined && record.id !== null && String(record.id).trim() !== "")
    );
    if (record.formId && customVouchersMap[String(record.formId)]) {
      code = customVouchersMap[String(record.formId)];
    } else if (record.id && customVouchersMap[record.id]) {
      code = customVouchersMap[record.id];
    } else if (!hasStableId && cleanVrm && !isPlaceholderVrm(cleanVrm)) {
      if (customVouchersMap[keyWithDate]) {
        code = customVouchersMap[keyWithDate];
      } else if (customVouchersMap[cleanVrm]) {
        code = customVouchersMap[cleanVrm];
      }
    } else {
      const rawCode = (record.voucherCode !== undefined && record.voucherCode !== null && record.voucherCode !== "") ? record.voucherCode : defaultVal;
      if (rawCode && String(rawCode).toUpperCase() === "CANCELLED") {
        code = defaultVal;
      } else {
        code = String(rawCode ?? "");
      }
    }

    if (code && code !== "-") {
      const codeUpper = String(code).toUpperCase();
      if (checkIsAssigned(codeUpper, new Set())) {
        code = "-";
      } else {
        registerCodeGlobally(codeUpper);
      }
    }
    return { ...record, voucherCode: code, hasOriginalVoucher };
  };

  if (!vouchersDb || vouchersDb.length === 0) {
    return recordsList.map((record, index) => mapRecordFallback(record, index, "-"));
  }

  const vouchersList: ParsedVoucherData[] = vouchersDb.filter(v => v && v.code);
  const recordClaimedCodes = new Map<number, string>();

  // ⭐ PERFORMANCE CACHE: Pre-index vouchers for O(1) lookups
  const voucherByCleanCode = new Map<string, ParsedVoucherData>();
  const availableVouchersByPeriod = new Map<string, ParsedVoucherData[]>();

  vouchersList.forEach(v => {
    if (!v || !v.code) return;
    const clean = cleanVoucherCodeValue(v.code).toUpperCase();
    if (!clean) return;
    if (!voucherByCleanCode.has(clean)) {
      voucherByCleanCode.set(clean, v);
    }

    if (isVoucherAvailableStatus(v)) {
      const vFrom = getVoucherValidFromISO(v);
      const vTo = getVoucherValidToISO(v);
      if (vFrom && vTo) {
        const pKey = `${vFrom}_${vTo}`;
        let pList = availableVouchersByPeriod.get(pKey);
        if (!pList) {
          pList = [];
          availableVouchersByPeriod.set(pKey, pList);
        }
        pList.push(v);
      }
    }
  });

  const getRecordSortInfo = (r: CsvPermitRecord, idx: number) => {
    const reqIso = getRequestedPermitDateISO(r, fallbackDateStr) || getTodayISO();
    const cand = r.startTime || r.createdAt || r.created_at || r.completionTime || r.validFrom || r.dateRequired;
    const timeMs = parseFullDateTimeMs(cand, reqIso) ?? new Date(reqIso).getTime();
    const numFormId = Number(r.formId ?? r.id ?? 0) || 0;
    return { timeMs, numFormId, idx };
  };

  const chronologicalIndices = recordsList
    .map((r, idx) => getRecordSortInfo(r, idx))
    .sort((a, b) => {
      if (a.numFormId > 0 && b.numFormId > 0 && a.numFormId !== b.numFormId) {
        return a.numFormId - b.numFormId;
      }
      if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
      return a.idx - b.idx;
    })
    .map(x => x.idx);

  const enrichedByIndex = new Map<number, CsvPermitRecord>();

  // Pass 0: Register all existing valid codes from database / custom overrides
  chronologicalIndices.forEach((index) => {
    const record = recordsList[index];
    const cleanVrm = record.vrm ? record.vrm.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    const customerKey = getCustomerKey(record);
    if (!assignedPerCustomer.has(customerKey)) {
      assignedPerCustomer.set(customerKey, new Set());
    }
    const custAssignedSet = assignedPerCustomer.get(customerKey)!;
    const reqIso = getRequestedPermitDateISO(record, fallbackDateStr);
    const reqIsoTo = record.validTo 
      ? (parseDateToISO(record.validTo) || (reqIso ? addDaysSafe(reqIso, 6) : ""))
      : (record.dateExpiry ? (parseDateToISO(record.dateExpiry) || (reqIso ? addDaysSafe(reqIso, 6) : "")) : (reqIso ? addDaysSafe(reqIso, 6) : ""));

    // Cancelled or blocked permits MUST NOT claim or consume vouchers
    if (
      isVrmSilentBlockedSync(record.vrm) ||
      record.isCancelled === true ||
      isRecordCancelled(record, reqIso || fallbackDateStr, recordsList) ||
      isPermitExpiredBackdate(record, reqIso || fallbackDateStr)
    ) {
      return;
    }

    const hasStableId = Boolean(
      (record.formId !== undefined && record.formId !== null && String(record.formId).trim() !== "") ||
      (record.id !== undefined && record.id !== null && String(record.id).trim() !== "")
    );
    const keyWithDate = (reqIso && cleanVrm && !isPlaceholderVrm(cleanVrm)) ? `${cleanVrm}_${reqIso}` : "";
    const customOverride = (record.formId ? customVouchersMap[String(record.formId)] : undefined) ||
                           (record.id ? customVouchersMap[String(record.id)] : undefined) ||
                           (!hasStableId && cleanVrm && !isPlaceholderVrm(cleanVrm)
                             ? ((keyWithDate ? customVouchersMap[keyWithDate] : undefined) || customVouchersMap[cleanVrm])
                             : undefined);

    const existingCode = record.voucherCode || record.prePaidCode || record.qrCode || record.serialNumber;

    // Fast O(1) check: Only accept customOverride if it exists in current vouchersDb and matches permit date
    if (customOverride && String(customOverride) !== "-" && String(customOverride).toUpperCase() !== "CANCELLED") {
      const clean = cleanVoucherCodeValue(String(customOverride)).toUpperCase();
      const matchingVoucherInDb = voucherByCleanCode.get(clean);
      const dateMatches = !reqIso || !matchingVoucherInDb || isVoucherForPermitDateRange(matchingVoucherInDb, reqIso, reqIsoTo);
      if (matchingVoucherInDb && dateMatches && clean && clean !== "-" && clean !== "CANCELLED" && !checkIsAssigned(clean, custAssignedSet)) {
        registerCodeGlobally(clean, custAssignedSet);
        recordClaimedCodes.set(index, clean);
      }
    } else if (existingCode && String(existingCode) !== "-" && String(existingCode).toUpperCase() !== "CANCELLED") {
      const clean = cleanVoucherCodeValue(String(existingCode)).toUpperCase();
      
      // Fast O(1) check: only accept if the code exists in current vouchersDatabase and matches permit date
      const matchingVoucherInDb = voucherByCleanCode.get(clean);
      const dateMatches = !reqIso || !matchingVoucherInDb || isVoucherForPermitDateRange(matchingVoucherInDb, reqIso, reqIsoTo);
      
      if (matchingVoucherInDb && dateMatches && clean !== "-" && clean !== "CANCELLED" && !checkIsAssigned(clean, custAssignedSet)) {
        registerCodeGlobally(clean, custAssignedSet);
        recordClaimedCodes.set(index, clean);
      }
    }
  });

  // Pass 1: Allocate vouchers using strict exact-period matching on requested permit date D:
  // Eligible if and only if voucher.validFrom === D AND voucher.validTo === addDays(D, 6).
  chronologicalIndices.forEach((index) => {
    const record = recordsList[index];
    const cleanVrm = record.vrm ? record.vrm.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    const reqDateD = getRequestedPermitDateISO(record, fallbackDateStr);
    const reqDateToD = record.validTo 
      ? (parseDateToISO(record.validTo) || (reqDateD ? addDaysSafe(reqDateD, 6) : ""))
      : (record.dateExpiry ? (parseDateToISO(record.dateExpiry) || (reqDateD ? addDaysSafe(reqDateD, 6) : "")) : (reqDateD ? addDaysSafe(reqDateD, 6) : ""));

    // Any VRM on the actual security blocklist is always blocked
    if (isVrmSilentBlockedSync(record.vrm)) {
      enrichedByIndex.set(index, {
        ...record,
        voucherCode: "CANCELLED",
        prePaidCode: "CANCELLED",
        hasOriginalVoucher: false
      });
      return;
    }

    if (isRecordCancelled(record, reqDateD || fallbackDateStr, recordsList) || isPermitExpiredBackdate(record, reqDateD || fallbackDateStr)) {
      const isBackdate = isPermitExpiredBackdate(record, reqDateD || fallbackDateStr);
      const reqIso = parseDateToISO(record.dateRequired || record.validFrom || "");
      const isExpired7Days = Boolean(fallbackDateStr && reqIso && Math.floor((new Date(reqIso + "T00:00:00").getTime() - new Date(parseDateToISO(fallbackDateStr) + "T00:00:00").getTime()) / 86400000) <= -7);
      const determinedReason = record.cancellationReason ||
        (isVrmSilentBlockedSync(record.vrm) ? "BLOCKLIST" :
        (isBackdate || isExpired7Days) ? "EXPIRED" :
        checkIsBlockedDuplicate(record, recordsList, reqDateD || fallbackDateStr) ? "DUPLICATE_VRM" :
        "MANUAL");

      enrichedByIndex.set(index, {
        ...record,
        status: "CANCELLED",
        isCancelled: true,
        cancellationReason: determinedReason,
        voucherCode: "CANCELLED",
        prePaidCode: "CANCELLED",
        hasOriginalVoucher: false
      });
      return;
    }

    const claimed = recordClaimedCodes.get(index);
    if (claimed) {
      enrichedByIndex.set(index, {
        ...record,
        voucherCode: claimed,
        prePaidCode: claimed,
        hasOriginalVoucher: true
      });
      return;
    }

    if (!reqDateD) {
      enrichedByIndex.set(index, {
        ...record,
        voucherCode: "-",
        prePaidCode: record.prePaidCode && record.prePaidCode !== "CANCELLED" ? record.prePaidCode : "-",
        hasOriginalVoucher: false
      });
      return;
    }

    const customerKey = getCustomerKey(record);
    if (!assignedPerCustomer.has(customerKey)) {
      assignedPerCustomer.set(customerKey, new Set());
    }
    const custAssignedSet = assignedPerCustomer.get(customerKey)!;

    // Fast bucketed candidates for this date period
    const periodBucket = availableVouchersByPeriod.get(`${reqDateD}_${reqDateToD}`);
    const candidateList = periodBucket && periodBucket.length > 0 ? periodBucket : vouchersList;

    // Filter available vouchers eligible for this EXACT requested permit date D
    const eligibleVouchers = candidateList.filter(v => {
      if (!isVoucherAvailableStatus(v)) return false;
      const cleanCode = cleanVoucherCodeValue(v.code).toUpperCase();
      if (!cleanCode || checkIsAssigned(cleanCode, custAssignedSet)) return false;
      return isVoucherExactPeriodEligible(v, reqDateD, reqDateToD);
    });

    let matchedVoucher: ParsedVoucherData | undefined;

    // 1. Try exact VRM match among eligible vouchers for requested date D
    if (cleanVrm) {
      matchedVoucher = eligibleVouchers.find(v => {
        const vVrm = (v.vrm || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        return vVrm && vVrm === cleanVrm;
      });
    }

    // 2. Try generic/unrestricted VRM voucher among eligible vouchers for requested date D
    if (!matchedVoucher) {
      matchedVoucher = eligibleVouchers.find(v => isVoucherVrmCompatible(v.vrm, cleanVrm));
    }

    if (matchedVoucher && matchedVoucher.code) {
      const code = cleanVoucherCodeValue(matchedVoucher.code).toUpperCase();
      registerCodeGlobally(code, custAssignedSet);
      enrichedByIndex.set(index, {
        ...record,
        voucherCode: code,
        prePaidCode: code,
        hasOriginalVoucher: true
      });
    } else {
      enrichedByIndex.set(index, {
        ...record,
        voucherCode: "-",
        prePaidCode: record.prePaidCode && record.prePaidCode !== "CANCELLED" ? record.prePaidCode : "-",
        hasOriginalVoucher: false
      });
    }
  });

  return recordsList.map((record, index) => enrichedByIndex.get(index) || record);
}

// Inexpensive equality check for string arrays / sets without JSON.stringify
const areStringSetsEqual = (a: string[] | undefined, b: string[] | undefined): boolean => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  let same = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { same = false; break; }
  }
  if (same) return true;
  const bSet = new Set(b);
  for (let i = 0; i < a.length; i++) {
    if (!bSet.has(a[i])) return false;
  }
  return true;
};

// Inexpensive equality check for Record<string, string> maps
const areRecordStringMapsEqual = (a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    const k = aKeys[i];
    if (a[k] !== b[k]) return false;
  }
  return true;
};

interface HiddenPermitCardEngineProps {
  cardRef: React.RefObject<PermitCardHandle | null>;
  data: PermitData;
  database: CsvPermitRecord[];
  vouchersDatabase: ParsedVoucherData[];
  dispatchedKeys: string[];
  unsentKeys: string[];
  dispatchBy: Record<string, string>;
  markAsDispatched: (vrm?: string, email?: string, record?: CsvPermitRecord) => Promise<boolean>;
  unmarkAsDispatched: (vrm?: string, email?: string, record?: CsvPermitRecord) => Promise<boolean>;
  onSelectRecord: (record: CsvPermitRecord) => void;
  onChange: (updates: Partial<PermitData>) => void;
}

const areHiddenPermitCardEnginePropsEqual = (
  prevProps: HiddenPermitCardEngineProps,
  nextProps: HiddenPermitCardEngineProps
): boolean => {
  if (prevProps.cardRef !== nextProps.cardRef) return false;
  if (prevProps.database !== nextProps.database) return false;
  if (prevProps.vouchersDatabase !== nextProps.vouchersDatabase) return false;
  if (prevProps.markAsDispatched !== nextProps.markAsDispatched) return false;
  if (prevProps.unmarkAsDispatched !== nextProps.unmarkAsDispatched) return false;
  if (prevProps.onSelectRecord !== nextProps.onSelectRecord) return false;
  if (prevProps.onChange !== nextProps.onChange) return false;

  if (!areStringSetsEqual(prevProps.dispatchedKeys, nextProps.dispatchedKeys)) return false;
  if (!areStringSetsEqual(prevProps.unsentKeys, nextProps.unsentKeys)) return false;
  if (!areRecordStringMapsEqual(prevProps.dispatchBy, nextProps.dispatchBy)) return false;

  const p = prevProps.data;
  const n = nextProps.data;
  if (p === n) return true;
  if (
    p.id !== n.id ||
    p.formId !== n.formId ||
    p.vrm !== n.vrm ||
    p.validFrom !== n.validFrom ||
    p.validTo !== n.validTo ||
    p.todayDate !== n.todayDate ||
    p.voucherCodesText !== n.voucherCodesText ||
    p.voucherCode !== n.voucherCode ||
    p.email !== n.email ||
    p.driverName !== n.driverName ||
    p.name !== n.name ||
    p.phone !== n.phone ||
    p.replacementCode !== n.replacementCode ||
    p.isResend !== n.isResend ||
    p.emailType !== n.emailType ||
    p.emailTemplate !== n.emailTemplate ||
    p.status !== n.status ||
    p.isCancelled !== n.isCancelled ||
    p.cancellationReason !== n.cancellationReason ||
    p.site !== n.site ||
    p.ward !== n.ward ||
    p.qrOverride !== n.qrOverride
  ) {
    return false;
  }
  return true;
};

const HiddenPermitCardEngine = React.memo(({
  cardRef,
  data,
  database,
  vouchersDatabase,
  dispatchedKeys,
  unsentKeys,
  dispatchBy,
  markAsDispatched,
  unmarkAsDispatched,
  onSelectRecord,
  onChange,
}: HiddenPermitCardEngineProps) => {
  return (
    <div id="print-card-wrapper" className="permit-card-engine" aria-hidden="true">
      <PermitCard
        ref={cardRef}
        isOffscreen={true}
        data={data}
        database={database}
        vouchersDatabase={vouchersDatabase}
        dispatchedKeys={dispatchedKeys}
        unsentKeys={unsentKeys}
        dispatchBy={dispatchBy}
        markAsDispatched={markAsDispatched}
        unmarkAsDispatched={unmarkAsDispatched}
        onSelectRecord={onSelectRecord}
        onChange={onChange}
      />
    </div>
  );
}, areHiddenPermitCardEnginePropsEqual);
HiddenPermitCardEngine.displayName = "HiddenPermitCardEngine";

export default function App() {
  const [currentUserName] = useState<string>(() => safeLocalStorage.getItem("realtime_user_name") || "Colleague_" + Math.floor(1000 + Math.random() * 9000));

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const cached = safeLocalStorage.getItem("concessions_dark_mode");
    if (cached !== null) {
      return cached === "true";
    }
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    return true;
  });

  useEffect(() => {
    safeLocalStorage.setItem("concessions_dark_mode", String(darkMode));
    if (darkMode) {
      document.body.classList.add("dark");
      document.documentElement.classList.add("dark");
    } else {
      document.body.classList.remove("dark");
      document.documentElement.classList.remove("dark");
    }
  }, [darkMode]);

  const handleToggleDarkMode = useCallback(() => setDarkMode(prev => !prev), []);

  const todayStr = getTodayISO();
  const next7DaysStr = addDays(todayStr, 6);

  const defaultState: PermitData = {
    title: "Patient & Visitor Concessions",
    site: "Main Site",
    name: "Fiona Gallagher",
    vrm: "LD68 UTX",
    validFrom: todayStr,
    validTo: next7DaysStr,
    ward: "Administration",
    qrOverride: "",
    voucherCodesText: "-",
    phone: "07700900077",
    email: "colleague@concessions-parking.com",
    todayDate: todayStr
  };

  const [formData, setFormData] = useState<PermitData>(() => {
    const tStr = getTodayISO();
    const n7DaysStr = addDays(tStr, 6);
    const cached = safeLocalStorage.getItem("concessions_permit_data");
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        // Do not restore voucher/QR fields from cache to avoid stale codes on load
        const {
          voucherCodesText,
          voucherCode,
          prePaidCode,
          qrCode,
          serialNumber,
          ...restFormData
        } = parsed;

        return {
          ...defaultState,
          ...restFormData,
          voucherCodesText: "-",
          name: parsed.name ? toTitleCase(parsed.name) : "",
          ward: parsed.ward ? toTitleCase(parsed.ward) : "",
          vrm: parsed.vrm ? parsed.vrm.toUpperCase() : "",
          email: parsed.email ? parsed.email.toLowerCase() : "",
          phone: parsed.phone !== undefined ? parsed.phone : defaultState.phone,
          validFrom: tStr,
          validTo: n7DaysStr,
          todayDate: parsed.todayDate || tStr
        };
      } catch (e) {}
    }
    return {
      ...defaultState,
      validFrom: tStr,
      validTo: n7DaysStr,
      todayDate: tStr
    };
  });

  const [database, setDatabase] = useState<CsvPermitRecord[]>(() => {
    const cached = safeLocalStorage.getItem("concessions_permit_db");
    try {
      if (!cached) return [];
      const parsed = JSON.parse(cached);
      return Array.isArray(parsed) ? autoCancelDuplicates(parsed) : [];
    } catch (e) {
      return [];
    }
  });
  const [vouchersDatabase, setVouchersDatabase] = useState<ParsedVoucherData[]>(() => {
    const cached = safeLocalStorage.getItem("concessions_vouchers_db") || safeLocalStorage.getItem("vouchers") || safeLocalStorage.getItem("activeCodes");
    try {
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const list = normalizeVouchersList(parsed);
          if (list.length > 0) return list;
        }
      }
    } catch (e) {}
    // ⭐ No dummy/sample codes here. Real vouchers only ever come from an
    // uploaded CSV or Supabase. If neither has loaded yet, stay empty —
    // the UI should show 0 available, never fabricate codes.
    return [];
  });

  // Storage Mode: "cloud" or "offline" - persisted in localStorage under "app_storage_mode"
  const [storageMode, setStorageMode] = useState<StorageMode>(() => {
    const saved = safeLocalStorage.getItem("app_storage_mode");
    return (saved === "offline" || saved === "cloud") ? (saved as StorageMode) : "cloud";
  });
  const storageModeRef = useRef<StorageMode>(storageMode);

  useEffect(() => {
    storageModeRef.current = storageMode;
    safeLocalStorage.setItem("app_storage_mode", storageMode);
  }, [storageMode]);

  const [emailTracking, setEmailTracking] = useState<Record<string, EmailTrackingInfo>>(() => {
    try {
      const saved = safeLocalStorage.getItem("concessions_email_tracking");
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return {};
  });

  const formDataRef = useRef(formData);
  useEffect(() => {
    formDataRef.current = formData;
  }, [formData]);

  // Background polling to keep email open tracking synced with backend
  useEffect(() => {
    const pollEmailStatuses = async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      try {
        const res = await fetch("/api/emails/statuses");
        if (!res.ok) return;
        const data = await res.json();
        if (data?.statuses) {
          setEmailTracking(prev => {
            let changed = false;
            const next = { ...prev };
            for (const [key, val] of Object.entries(data.statuses as Record<string, any>)) {
              const current = next[key];
              if (!current || current.status !== val.status || current.openedAt !== val.openedAt || current.openCount !== val.openCount) {
                next[key] = {
                  status: val.status,
                  sentAt: val.sentAt || current?.sentAt,
                  openedAt: val.openedAt,
                  openCount: val.openCount,
                  trackingId: val.trackingId || current?.trackingId
                };
                changed = true;
              }
            }
            if (changed) {
              safeLocalStorage.setItem("concessions_email_tracking", JSON.stringify(next));
              return next;
            }
            return prev;
          });
        }
      } catch (e) {}
    };

    pollEmailStatuses();
    const interval = setInterval(pollEmailStatuses, 8000);
    const handleFocus = () => pollEmailStatuses();
    window.addEventListener("focus", handleFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  const [isSyncing, setIsSyncing] = useState(false);
  const [showBlocklist, setShowBlocklist] = useState<boolean>(false);
  const [syncToast, setSyncToast] = useState<{ message: string; type: "success" | "info" | "warning" | "error" } | null>(null);
  const [editingRecord, setEditingRecord] = useState<CsvPermitRecord | null>(null);
  const [editingResolvedVoucherCode, setEditingResolvedVoucherCode] = useState<string>("");
  const [isEditModalOpen, setIsEditModalOpen] = useState<boolean>(false);
  const [isPreviewCardOpen, setIsPreviewCardOpen] = useState<boolean>(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isPreviewCardOpen) {
        setIsPreviewCardOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPreviewCardOpen]);

  const showToast = useCallback((message: string, type: "success" | "info" | "warning" | "error" = "success") => {
    setSyncToast({ message, type });
    setTimeout(() => {
      setSyncToast(prev => prev?.message === message ? null : prev);
    }, 4500);
  }, []);

  const databaseRef = useRef<CsvPermitRecord[]>(database);
  const vouchersDatabaseRef = useRef<ParsedVoucherData[]>(vouchersDatabase);

  useEffect(() => {
    databaseRef.current = database;
  }, [database]);

  useEffect(() => {
    vouchersDatabaseRef.current = vouchersDatabase;
  }, [vouchersDatabase]);

  const [customVouchers, setCustomVouchers] = useState<{[vrm: string]: string}>(() => {
    const cached = safeLocalStorage.getItem("concessions_custom_vouchers");
    try {
      return cached ? JSON.parse(cached) : {};
    } catch (e) {
      return {};
    }
  });

  const customVouchersRef = useRef<{[vrm: string]: string}>(customVouchers);
  useEffect(() => {
    customVouchersRef.current = customVouchers;
  }, [customVouchers]);

  const [dispatchBy, setDispatchBy] = useState<{[key: string]: string}>(() => {
    const cached = safeLocalStorage.getItem("concessions_dispatch_by");
    try { return cached ? JSON.parse(cached) : {}; } catch (e) { return {}; }
  });
  const [dispatchedKeys, setDispatchedKeys] = useState<string[]>(() => {
    const cached = safeLocalStorage.getItem("concessions_dispatched_keys");
    try { return cached ? JSON.parse(cached) : []; } catch (e) { return []; }
  });
  const [dispatchDates, setDispatchDates] = useState<{[key: string]: string}>(() => {
    const cached = safeLocalStorage.getItem("concessions_dispatch_dates");
    try { return cached ? JSON.parse(cached) : {}; } catch (e) { return {}; }
  });
  const [unsentKeys, setUnsentKeys] = useState<string[]>([]);

  const dispatchedKeysRef = useRef<string[]>(dispatchedKeys);
  const unsentKeysRef = useRef<string[]>(unsentKeys);
  const dispatchDatesRef = useRef<Record<string, string>>(dispatchDates);
  const dispatchByRef = useRef<Record<string, string>>(dispatchBy);

  useEffect(() => {
    dispatchedKeysRef.current = dispatchedKeys;
  }, [dispatchedKeys]);

  useEffect(() => {
    unsentKeysRef.current = unsentKeys;
  }, [unsentKeys]);

  useEffect(() => {
    dispatchDatesRef.current = dispatchDates;
  }, [dispatchDates]);

  useEffect(() => {
    dispatchByRef.current = dispatchBy;
  }, [dispatchBy]);

  useEffect(() => {
    const todayISO = getTodayISO();
    let updated = { ...dispatchDates };
    let changed = false;
    dispatchedKeys.forEach(key => {
      if (!updated[key]) {
        updated[key] = todayISO;
        changed = true;
      }
    });
    if (changed) {
      setDispatchDates(updated);
      dispatchDatesRef.current = updated;
    }
  }, [dispatchedKeys]);

  const [activeTab, setActiveTab] = useState<"dispatcher">("dispatcher");
  const permitCardRef = useRef<PermitCardHandle>(null);
  const csvPanelRef = useRef<CsvDatabasePanelHandle>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [lastProcessedDate, setLastProcessedDate] = useState<string>("");
  const [lastDbLength, setLastDbLength] = useState<number>(0);
  const refreshInFlightRef = useRef<boolean>(false);
  const refreshRequestIdRef = useRef<number>(0);
  const lastOfflineDbRawRef = useRef<string | null>(null);

  // Helper to clear replacement state and promote replacement code to primary code on successful dispatch
  const handleReplacementSuccessCleanup = (targetRecord: CsvPermitRecord) => {
    // If targetRecord is already clean and marked as dispatched SENT, nothing to clean up
    if (
      targetRecord.status === "SENT" &&
      targetRecord.isDispatched === true &&
      !targetRecord.replacementCode &&
      !targetRecord.isResend &&
      !targetRecord.emailType &&
      !targetRecord.emailTemplate
    ) {
      return;
    }

    const isTargetReplacement = Boolean(
      targetRecord.replacementCode ||
      targetRecord.emailType === "RESEND_CONCESSION" ||
      targetRecord.isResend ||
      targetRecord.emailTemplate === "replacement" ||
      (isRecordMatch(targetRecord, formData) && (formData.emailType === "RESEND_CONCESSION" || formData.isResend || formData.replacementCode))
    );

    if (isTargetReplacement) {
      const repCode = targetRecord.replacementCode || (isRecordMatch(targetRecord, formData) ? formData.replacementCode : undefined);

      setDatabase(prevDb => {
        let matched = false;
        let needsUpdate = false;
        let updatedRecordToSync: CsvPermitRecord | null = null;
        const nextDb = prevDb.map(item => {
          if (isRecordMatch(item, targetRecord)) {
            matched = true;
            const targetVoucher = repCode || item.voucherCode;
            // Prevent redundant updates if this record was already promoted / updated
            if (
              item.voucherCode === targetVoucher &&
              item.status === "SENT" &&
              item.isDispatched === true &&
              !item.replacementCode &&
              !item.isResend &&
              !item.emailType &&
              !item.emailTemplate
            ) {
              return item;
            }

            needsUpdate = true;
            const updated = {
              ...item,
              voucherCode: targetVoucher,
              voucherCodesText: targetVoucher,
              prePaidCode: targetVoucher,
              originalVoucherCode: item.voucherCode || item.originalVoucherCode,
              replacementCode: undefined,
              emailType: undefined,
              isResend: false,
              emailTemplate: undefined,
              status: "SENT",
              isDispatched: true
            };
            updatedRecordToSync = updated;
            return updated;
          }
          return item;
        });

        if (!needsUpdate || !matched) {
          // Record was already updated; avoid redundant state rewrite, localStorage serialization, and DB sync
          return prevDb;
        }

        databaseRef.current = nextDb;
        safeLocalStorage.setItem("concessions_permit_db", JSON.stringify(nextDb));
        if (storageModeRef.current === "cloud" && isSupabaseConfigured() && updatedRecordToSync) {
          updatePermitInSupabase(updatedRecordToSync).catch(e => console.error("Targeted permit sync after replacement send failed:", e));
        }
        return nextDb;
      });

      if (repCode) {
        setCustomVouchers(prev => {
          const cleanVrm = targetRecord.vrm ? targetRecord.vrm.toUpperCase().replace(/\s+/g, "") : "";
          const dateISO = parseDateToISO(targetRecord.dateRequired || "") || getTodayISO();
          if (
            (!targetRecord.formId || prev[String(targetRecord.formId)] === repCode) &&
            (!targetRecord.id || prev[String(targetRecord.id)] === repCode) &&
            (!cleanVrm || prev[cleanVrm] === repCode)
          ) {
            return prev;
          }

          const next = { ...prev };
          if (targetRecord.formId) next[String(targetRecord.formId)] = repCode;
          if (targetRecord.id) next[String(targetRecord.id)] = repCode;
          if (cleanVrm) {
            next[cleanVrm] = repCode;
            if (dateISO) next[`${cleanVrm}_${dateISO}`] = repCode;
          }
          safeLocalStorage.setItem("concessions_custom_vouchers", JSON.stringify(next));
          return next;
        });
      }

      setFormData(prev => {
        if (isRecordMatch(targetRecord, prev)) {
          if (
            prev.voucherCodesText === (repCode || prev.voucherCodesText) &&
            !prev.replacementCode &&
            !prev.isResend &&
            prev.emailType === "SEND_CONCESSION" &&
            prev.emailTemplate === "new" &&
            prev.status === "SENT"
          ) {
            return prev;
          }
          return {
            ...prev,
            voucherCodesText: repCode || prev.voucherCodesText,
            replacementCode: undefined,
            isResend: false,
            emailType: "SEND_CONCESSION",
            emailTemplate: "new",
            status: "SENT"
          };
        }
        return prev;
      });
    }
  };

  // 🔥 DISPATCH STATUS HANDLER: Writes to Supabase first, then syncs React state
  const markAsDispatched = useCallback(async (vrm?: string, email?: string, record?: CsvPermitRecord): Promise<boolean> => {
    lastUserActionTimestampRef.current = Date.now();
    
    const currentDb = databaseRef.current || [];
    const targetRecord: CsvPermitRecord | undefined = record || (vrm ? currentDb.find(r => r.vrm && r.vrm.toUpperCase().replace(/\s+/g, "") === vrm.toUpperCase().replace(/\s+/g, "")) : undefined) || (vrm ? { vrm, email } : undefined);
    if (!targetRecord) {
      console.error("❌ Record not found. Cannot mark as dispatched.");
      alert("❌ Record not found. Cannot mark as dispatched.");
      return false;
    }

    const pk = getRecordPrimaryKey(targetRecord);
    const allKeys = getRecordKeys(targetRecord);
    const combinedKeys = Array.from(new Set([pk, ...allKeys].filter(Boolean)));

    const todayISO = getTodayISO();
    const currentUser = currentUserName || 'System User';

    // If in Offline Local Storage mode, save directly to localStorage without network calls
    if (storageModeRef.current === "offline") {
      setDispatchedKeys(prev => {
        const next = Array.from(new Set([...prev, ...combinedKeys]));
        dispatchedKeysRef.current = next;
        safeLocalStorage.setItem("concessions_dispatched_keys", JSON.stringify(next));
        return next;
      });
      setDispatchDates(prev => {
        const updated = { ...prev };
        combinedKeys.forEach(k => { updated[k] = todayISO; });
        dispatchDatesRef.current = updated;
        safeLocalStorage.setItem("concessions_dispatch_dates", JSON.stringify(updated));
        return updated;
      });
      setDispatchBy(prev => {
        const updated = { ...prev };
        combinedKeys.forEach(k => { updated[k] = currentUser; });
        dispatchByRef.current = updated;
        safeLocalStorage.setItem("concessions_dispatch_by", JSON.stringify(updated));
        return updated;
      });
      setUnsentKeys(prev => {
        const next = prev.filter(k => !combinedKeys.includes(k));
        if (next.length === prev.length) return prev;
        unsentKeysRef.current = next;
        return next;
      });
      handleReplacementSuccessCleanup(targetRecord);
      console.log("💾 [Offline Storage] Record marked as dispatched locally");
      return true;
    }

    // Optimistically update React state immediately so UI changes to Sent instantly with zero lag
    setDispatchedKeys(prev => {
      const next = Array.from(new Set([...prev, ...combinedKeys]));
      dispatchedKeysRef.current = next;
      return next;
    });
    setDispatchDates(prev => {
      const updated = { ...prev };
      combinedKeys.forEach(k => { updated[k] = todayISO; });
      dispatchDatesRef.current = updated;
      return updated;
    });
    setDispatchBy(prev => {
      const updated = { ...prev };
      combinedKeys.forEach(k => { updated[k] = currentUser; });
      dispatchByRef.current = updated;
      return updated;
    });
    setUnsentKeys(prev => {
      const next = prev.filter(k => !combinedKeys.includes(k));
      if (next.length === prev.length) return prev;
      unsentKeysRef.current = next;
      return next;
    });

    // 1. Write dispatch log to Supabase FIRST
    try {
      const result = await markRecordAsDispatched(
        targetRecord,
        currentUser
      );

      if (!result.success) {
        console.error("❌ [Supabase Dispatch Write Error]:", result.error);
        // Rollback on error
        setDispatchedKeys(prev => {
          const next = prev.filter(k => !combinedKeys.includes(k));
          dispatchedKeysRef.current = next;
          return next;
        });
        alert(`❌ Database Error: ${result.error || 'Failed to save dispatch status in database.'}`);
        return false;
      }

      console.log("✅ [Supabase Dispatch Write Success] Record marked as dispatched in database");

      // 2. Persist local dispatch state/ref immediately (known success, avoids re-downloading entire dispatched_history)
      safeLocalStorage.setItem("concessions_dispatched_keys", JSON.stringify(dispatchedKeysRef.current));
      safeLocalStorage.setItem("concessions_dispatch_dates", JSON.stringify(dispatchDatesRef.current));
      safeLocalStorage.setItem("concessions_dispatch_by", JSON.stringify(dispatchByRef.current));

      handleReplacementSuccessCleanup(targetRecord);

      return true;
    } catch (err: any) {
      console.error("❌ [Supabase Dispatch Exception]:", err);
      // Rollback on exception
      setDispatchedKeys(prev => {
        const next = prev.filter(k => !combinedKeys.includes(k));
        dispatchedKeysRef.current = next;
        return next;
      });
      alert(`❌ Dispatch Exception: ${err.message || 'Unknown database error'}`);
      return false;
    }
  }, [currentUserName]);

  // 🔥 UNMARK DISPATCH HANDLER: Removes from Supabase and updates state
  const unmarkAsDispatched = useCallback(async (vrm?: string, email?: string, record?: CsvPermitRecord): Promise<boolean> => {
    lastUserActionTimestampRef.current = Date.now();
    
    const currentDb = databaseRef.current || [];
    const targetRecord: CsvPermitRecord | undefined = record || (vrm ? currentDb.find(r => r.vrm && r.vrm.toUpperCase().replace(/\s+/g, "") === vrm.toUpperCase().replace(/\s+/g, "")) : undefined) || (vrm ? { vrm, email } : undefined);
    if (!targetRecord) {
      console.error("❌ Record not found. Cannot unmark as dispatched.");
      alert("❌ Record not found. Cannot unmark as dispatched.");
      return false;
    }

    const pk = getRecordPrimaryKey(targetRecord);
    const allKeys = getRecordKeys(targetRecord);
    const combinedKeys = Array.from(new Set([pk, ...allKeys].filter(Boolean)));

    // Optimistically update React state immediately in both offline and cloud modes
    setDispatchedKeys(prev => {
      const next = prev.filter(k => !combinedKeys.includes(k));
      dispatchedKeysRef.current = next;
      safeLocalStorage.setItem("concessions_dispatched_keys", JSON.stringify(next));
      return next;
    });
    setDispatchDates(prev => {
      const updated = { ...prev };
      combinedKeys.forEach(k => { delete updated[k]; });
      dispatchDatesRef.current = updated;
      safeLocalStorage.setItem("concessions_dispatch_dates", JSON.stringify(updated));
      return updated;
    });
    setDispatchBy(prev => {
      const updated = { ...prev };
      combinedKeys.forEach(k => { delete updated[k]; });
      dispatchByRef.current = updated;
      safeLocalStorage.setItem("concessions_dispatch_by", JSON.stringify(updated));
      return updated;
    });
    // Update the ref BEFORE scheduling React state so a background refresh
    // that starts immediately after Unsend can never miss the override.
    const nextUnsentKeys = Array.from(new Set([...(unsentKeysRef.current || []), ...combinedKeys]));
    unsentKeysRef.current = nextUnsentKeys;
    setUnsentKeys(nextUnsentKeys);

    // If in Offline Local Storage mode, state and storage are already updated
    if (storageModeRef.current === "offline") {
      console.log("💾 [Offline Storage] Record unmarked as dispatched locally");
      return true;
    }

    // 1. Remove from Supabase FIRST
    try {
      const result = await unmarkRecordAsDispatched(targetRecord);
      if (!result.success) {
        console.error("❌ [Supabase Unmark Error]:", result.error);
        // The delete failed, so restore the previous dispatched state and
        // remove the local unsent override.
        dispatchedKeysRef.current = Array.from(new Set([...(dispatchedKeysRef.current || []), ...combinedKeys]));
        setDispatchedKeys(dispatchedKeysRef.current);
        const rolledBackUnsent = (unsentKeysRef.current || []).filter(k => !combinedKeys.includes(k));
        unsentKeysRef.current = rolledBackUnsent;
        setUnsentKeys(rolledBackUnsent);
        alert(`❌ Database Error: ${result.error || 'Failed to remove dispatch status.'}`);
        return false;
      }

      console.log("✅ [Supabase Unmark Success] Record unmarked as dispatched");

      // Local optimistic state is already updated and persisted cleanly.
      // Do NOT run immediate background refreshes that could overwrite local Unsend overrides.
      return true;
    } catch (err: any) {
      console.error("❌ [Supabase Unmark Exception]:", err);
      dispatchedKeysRef.current = Array.from(new Set([...(dispatchedKeysRef.current || []), ...combinedKeys]));
      setDispatchedKeys(dispatchedKeysRef.current);
      const rolledBackUnsent = (unsentKeysRef.current || []).filter(k => !combinedKeys.includes(k));
      unsentKeysRef.current = rolledBackUnsent;
      setUnsentKeys(rolledBackUnsent);
      return false;
    }
  }, []);

  const clearDispatchedHistory = async () => {
    dispatchedKeysRef.current = [];
    unsentKeysRef.current = [];
    dispatchDatesRef.current = {};
    dispatchByRef.current = {};

    setDispatchedKeys([]);
    setUnsentKeys([]);
    setDispatchDates({});
    
    if (isSupabaseConfigured()) {
      await clearSupabaseDispatches();
    }
  };

  useEffect(() => {
    safeLocalStorage.setItem("concessions_permit_data", JSON.stringify(formData));
  }, [formData]);

  const initialSupabaseSyncDone = useRef(false);

  const [isSupabaseActive, setIsSupabaseActive] = useState<boolean>(() => isSupabaseConfigured());
  // ⭐ FIX: Restore default filter to "This Week" ('7days')
  const [dateRangeFilter, setDateRangeFilter] = useState<'7days' | '30days' | 'all'>('7days');
  const dateRangeFilterRef = useRef(dateRangeFilter);
  useEffect(() => {
    dateRangeFilterRef.current = dateRangeFilter;
  }, [dateRangeFilter]);

  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [hasFullHistoryLoaded, setHasFullHistoryLoaded] = useState(false);
  const [totalRecordsCount, setTotalRecordsCount] = useState<number>(0);

  const lastUserActionTimestampRef = useRef<number>(0);
  const isSilentRefetchRef = useRef<boolean>(false);

  // ⚡ Lightweight helper: Refreshes ONLY dispatched keys from Supabase without refetching permits or vouchers
  const refreshDispatchedKeysOnly = async () => {
    if (!isSupabaseConfigured()) return;
    try {
      const dbDispatchedData = await fetchDispatchedFromSupabase();
      if (dbDispatchedData && dbDispatchedData.dispatchedKeys) {
        const isCorrupted = (k: string) => {
          if (!k || !k.trim()) return true;
          const clean = k.trim();
          if (/^\d{8}$/.test(clean)) return true;
          if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return true;
          if (clean.toUpperCase() === 'UNDEFINED' || clean.toUpperCase() === 'NULL') return true;
          return false;
        };

        const currentUnsent = new Set(unsentKeysRef.current || []);
        const validKeys = dbDispatchedData.dispatchedKeys
          .filter(k => !isCorrupted(k))
          .filter(k => !currentUnsent.has(k));
        const filteredDates = Object.fromEntries(
          Object.entries(dbDispatchedData.dispatchDates || {}).filter(([k]) => !currentUnsent.has(k))
        );
        const filteredDispatchBy = Object.fromEntries(
          Object.entries(dbDispatchedData.dispatchBy || {}).filter(([k]) => !currentUnsent.has(k))
        );

        const isDispatchedEqual = areStringSetsEqual(dispatchedKeysRef.current, validKeys);
        if (!isDispatchedEqual) {
          dispatchedKeysRef.current = validKeys;
          setDispatchedKeys(validKeys);
          safeLocalStorage.setItem("concessions_dispatched_keys", JSON.stringify(validKeys));
        }

        const isDatesEqual = areRecordStringMapsEqual(dispatchDatesRef.current, filteredDates);
        if (!isDatesEqual) {
          dispatchDatesRef.current = filteredDates;
          setDispatchDates(filteredDates);
          safeLocalStorage.setItem("concessions_dispatch_dates", JSON.stringify(filteredDates));
        }

        const isByEqual = areRecordStringMapsEqual(dispatchByRef.current, filteredDispatchBy);
        if (!isByEqual) {
          dispatchByRef.current = filteredDispatchBy;
          setDispatchBy(filteredDispatchBy);
          safeLocalStorage.setItem("concessions_dispatch_by", JSON.stringify(filteredDispatchBy));
        }
      }
    } catch (err) {
      console.warn("Dispatched keys background sync error:", err);
    }
  };

  // 🔥 FIX: refreshDatabase - loads dispatched keys from Supabase without stale state closures
  const refreshDatabase = useCallback(async (overrideFilter?: '7days' | '30days' | 'all', silent: boolean = false) => {
    // If in Offline Local Storage mode, do NOT perform network calls
    if (storageModeRef.current === "offline") {
      const localDbStr = safeLocalStorage.getItem("concessions_permit_db");
      const localVouchersStr = safeLocalStorage.getItem("concessions_vouchers_db");
      const localDispatchedStr = safeLocalStorage.getItem("concessions_dispatched_keys");
      const localDatesStr = safeLocalStorage.getItem("concessions_dispatch_dates");
      const localByStr = safeLocalStorage.getItem("concessions_dispatch_by");

      if (localDbStr && localDbStr !== lastOfflineDbRawRef.current) {
        try {
          const parsed = JSON.parse(localDbStr);
          const reconciled = Array.isArray(parsed) ? autoCancelDuplicates(parsed) : [];
          databaseRef.current = reconciled;
          setDatabase(reconciled);
          setTotalRecordsCount(reconciled.length);
          lastOfflineDbRawRef.current = localDbStr;
        } catch (e) {}
      }
      if (localVouchersStr) {
        try {
          const parsed = JSON.parse(localVouchersStr);
          const normalized = normalizeVouchersList(parsed);
          const currentVouchers = vouchersDatabaseRef.current || [];
          const isVouchersIdentical = currentVouchers.length === normalized.length && currentVouchers.every((v, idx) => {
            const target = normalized[idx];
            return target && v.code === target.code && v.vrm === target.vrm && v.validFrom === target.validFrom && v.validTo === target.validTo && v.isUsed === target.isUsed && v.status === target.status;
          });
          if (!isVouchersIdentical) {
            vouchersDatabaseRef.current = normalized;
            setVouchersDatabase(normalized);
          }
        } catch (e) {}
      }
      if (localDispatchedStr) {
        try {
          const parsed = JSON.parse(localDispatchedStr);
          if (Array.isArray(parsed) && !areStringSetsEqual(dispatchedKeysRef.current, parsed)) {
            dispatchedKeysRef.current = parsed;
            setDispatchedKeys(parsed);
          }
        } catch (e) {}
      }
      if (localDatesStr) {
        try {
          const parsed = JSON.parse(localDatesStr);
          if (parsed && typeof parsed === "object" && !areRecordStringMapsEqual(dispatchDatesRef.current, parsed)) {
            dispatchDatesRef.current = parsed;
            setDispatchDates(parsed);
          }
        } catch (e) {}
      }
      if (localByStr) {
        try {
          const parsed = JSON.parse(localByStr);
          if (parsed && typeof parsed === "object" && !areRecordStringMapsEqual(dispatchByRef.current, parsed)) {
            dispatchByRef.current = parsed;
            setDispatchBy(parsed);
          }
        } catch (e) {}
      }
      return;
    }

    if (!isSupabaseConfigured()) return;

    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    const reqId = ++refreshRequestIdRef.current;

    if (!silent) {
      setIsLoadingHistory(true);
    }
    isSilentRefetchRef.current = silent;

    try {
      // Background polling is bounded to 90 days to cover duplicate-VRM checking,
      // backdated concession windows, and monthly reconciliation with optimal performance.
      const [dbPermits, dbVouchers, dbDispatchedData] = await Promise.all([
        fetchPermitsFromSupabase({ daysLimit: 90 }),
        fetchVouchersFromSupabase(),
        fetchDispatchedFromSupabase()
      ]);

      if (reqId !== refreshRequestIdRef.current) return;

      if (dbPermits) {
        const currentDb = databaseRef.current;
        const isIdentical = currentDb.length === dbPermits.length && currentDb.every((rec, idx) => {
          const target = dbPermits[idx];
          return target &&
            rec.id === target.id &&
            rec.formId === target.formId &&
            rec.vrm === target.vrm &&
            rec.driverName === target.driverName &&
            rec.dateRequired === target.dateRequired &&
            rec.voucherCode === target.voucherCode &&
            rec.voucherCodesText === target.voucherCodesText &&
            rec.status === target.status &&
            rec.isCancelled === target.isCancelled &&
            rec.startTime === target.startTime;
        });

        if (!isIdentical) {
          // O(1) indexed Map merge: preserve any local records older than 90 days
          const currentDbMap = new Map<string, CsvPermitRecord>();
          for (const rec of currentDb) {
            const key = getNormalizedPermitKey(rec);
            if (key) currentDbMap.set(key, rec);
          }

          const mergedMap = new Map<string, CsvPermitRecord>(currentDbMap);

          for (const dbRec of dbPermits) {
            const key = getNormalizedPermitKey(dbRec);
            const localMatch = key ? currentDbMap.get(key) : undefined;
            if (localMatch && (localMatch.replacementCode || localMatch.isResend || localMatch.emailTemplate === "replacement")) {
              mergedMap.set(key || String(dbRec.id), {
                ...dbRec,
                replacementCode: localMatch.replacementCode,
                isResend: localMatch.isResend,
                emailType: localMatch.emailType,
                emailTemplate: localMatch.emailTemplate
              });
            } else {
              mergedMap.set(key || String(dbRec.id), dbRec);
            }
          }

          const mergedPermits = Array.from(mergedMap.values());
          const reconciled = autoCancelDuplicates(mergedPermits);
          databaseRef.current = reconciled;
          setDatabase(reconciled);
          safeLocalStorage.setItem("concessions_permit_db", JSON.stringify(reconciled));
        }

        // ⭐ CRITICAL: Always synchronize active permit formData with authoritative database state
        const currentPermits = databaseRef.current;
        if (currentPermits && currentPermits.length > 0) {
          setFormData(prev => {
            const matched = currentPermits.find(r => isRecordMatch(r, prev));
            if (!matched) return prev;

            const cleanVrmMatched = (matched.vrm ? matched.vrm.toUpperCase() : "");
            const cleanNameMatched = (matched.driverName ? toTitleCase(matched.driverName) : "");
            const cleanWardMatched = (matched.ward ? toTitleCase(matched.ward) : "");
            const cleanSiteMatched = (matched.hospital || "");
            const cleanDateMatched = (matched.validFrom || matched.dateRequired || "");
            const cleanPhoneMatched = formatPhoneNumber(matched.phone || "");
            const cleanEmailMatched = (matched.email || "").toLowerCase();

            const hasRep = Boolean(matched.replacementCode || prev.replacementCode);
            const repCode = matched.replacementCode || prev.replacementCode;
            const vCode = hasRep ? repCode : (matched.voucherCode || prev.voucherCodesText || "-");

            if (
              prev.vrm === cleanVrmMatched &&
              prev.name === cleanNameMatched &&
              prev.site === cleanSiteMatched &&
              prev.ward === cleanWardMatched &&
              prev.validFrom === cleanDateMatched &&
              prev.phone === cleanPhoneMatched &&
              prev.email === cleanEmailMatched &&
              prev.voucherCodesText === vCode &&
              prev.status === (matched.status || prev.status) &&
              prev.validTo === (matched.validTo || matched.dateExpiry || prev.validTo)
            ) {
              return prev;
            }

            return {
              ...prev,
              id: matched.id || prev.id,
              formId: matched.formId || prev.formId,
              site: cleanSiteMatched || prev.site,
              name: cleanNameMatched || prev.name,
              vrm: cleanVrmMatched || prev.vrm,
              ward: cleanWardMatched || prev.ward,
              validFrom: cleanDateMatched || prev.validFrom,
              validTo: matched.validTo || matched.dateExpiry || prev.validTo,
              phone: cleanPhoneMatched || prev.phone,
              email: cleanEmailMatched || prev.email,
              voucherCodesText: vCode,
              status: matched.status || prev.status,
              startTime: matched.startTime || prev.startTime,
              completionTime: matched.completionTime || prev.completionTime,
              createdAt: matched.createdAt || prev.createdAt
            };
          });
        }

        const countFromDb = (dbPermits as { totalCount?: number }).totalCount;
        const nextTotal = (typeof countFromDb === 'number' && countFromDb > 0) ? countFromDb : databaseRef.current.length;
        setTotalRecordsCount(prev => prev === nextTotal ? prev : nextTotal);
        setHasFullHistoryLoaded(prev => prev ? false : prev);
      }
      if (dbVouchers) {
        const currentVouchersDb = vouchersDatabaseRef.current || [];
        const isVouchersIdentical = currentVouchersDb.length === dbVouchers.length && currentVouchersDb.every((v, idx) => {
          const target = dbVouchers[idx];
          return target && v.code === target.code && v.vrm === target.vrm && v.validFrom === target.validFrom && v.validTo === target.validTo && v.isUsed === target.isUsed && v.status === target.status;
        });
        if (!isVouchersIdentical) {
          vouchersDatabaseRef.current = dbVouchers;
          setVouchersDatabase(dbVouchers);
          safeLocalStorage.setItem("concessions_vouchers_db", JSON.stringify(dbVouchers));
        }
      }
      
      // 🔥 FIX: Update dispatched keys directly from Supabase (Source of Truth)
      if (dbDispatchedData && dbDispatchedData.dispatchedKeys) {
        const isCorrupted = (k: string) => {
          if (!k || !k.trim()) return true;
          const clean = k.trim();
          if (/^\d{8}$/.test(clean)) return true;
          if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return true;
          if (clean.toUpperCase() === 'UNDEFINED' || clean.toUpperCase() === 'NULL') return true;
          return false;
        };

        const currentUnsent = new Set(unsentKeysRef.current || []);
        const validKeys = dbDispatchedData.dispatchedKeys
          .filter(k => !isCorrupted(k))
          .filter(k => !currentUnsent.has(k));

        // Never let a background read undo an explicit Unsend action.
        // Supabase can briefly return a stale row after the delete, so the
        // local unsent override always wins until the user sends again.
        const filteredDates = Object.fromEntries(
          Object.entries(dbDispatchedData.dispatchDates || {}).filter(([k]) => !currentUnsent.has(k))
        );
        const filteredDispatchBy = Object.fromEntries(
          Object.entries(dbDispatchedData.dispatchBy || {}).filter(([k]) => !currentUnsent.has(k))
        );

        const isDispatchedEqual = areStringSetsEqual(dispatchedKeysRef.current, validKeys);
        if (!isDispatchedEqual) {
          dispatchedKeysRef.current = validKeys;
          setDispatchedKeys(validKeys);
          safeLocalStorage.setItem("concessions_dispatched_keys", JSON.stringify(validKeys));
        }

        const isDatesEqual = areRecordStringMapsEqual(dispatchDatesRef.current, filteredDates);
        if (!isDatesEqual) {
          dispatchDatesRef.current = filteredDates;
          setDispatchDates(filteredDates);
          safeLocalStorage.setItem("concessions_dispatch_dates", JSON.stringify(filteredDates));
        }

        const isByEqual = areRecordStringMapsEqual(dispatchByRef.current, filteredDispatchBy);
        if (!isByEqual) {
          dispatchByRef.current = filteredDispatchBy;
          setDispatchBy(filteredDispatchBy);
          safeLocalStorage.setItem("concessions_dispatch_by", JSON.stringify(filteredDispatchBy));
        }
      }
    } catch (err) {
      console.warn("Real-time database fetch error:", err);
    } finally {
      refreshInFlightRef.current = false;
      if (!silent) {
        setIsLoadingHistory(false);
      }
    }
  }, []);

  // 🔥 Manual Sync Handler for Cloud Mode
  const handleManualSync = useCallback(async () => {
    if (storageModeRef.current !== "cloud") return;
    setIsSyncing(true);
    try {
      await refreshDatabase(undefined, false);
      showToast("Database successfully synced with Supabase cloud!", "success");
    } catch (err: any) {
      showToast(`Sync failed: ${err?.message || 'Network error'}`, "error");
    } finally {
      setIsSyncing(false);
    }
  }, [refreshDatabase, showToast]);

  // 🔥 Toggle Storage Mode (Cloud <-> Offline) with automatic sync on reconnect
  const handleToggleStorageMode = useCallback(async () => {
    if (storageModeRef.current === "cloud") {
      // Switching from Cloud to Offline
      setStorageMode("offline");
      storageModeRef.current = "offline";
      safeLocalStorage.setItem("app_storage_mode", "offline");
      
      // Save current in-memory state to localStorage for offline access
      if (databaseRef.current && databaseRef.current.length > 0) {
        safeLocalStorage.setItem("concessions_permit_db", JSON.stringify(databaseRef.current));
      }
      if (vouchersDatabaseRef.current && vouchersDatabaseRef.current.length > 0) {
        safeLocalStorage.setItem("concessions_vouchers_db", JSON.stringify(vouchersDatabaseRef.current));
      }
      if (dispatchedKeysRef.current && dispatchedKeysRef.current.length > 0) {
        safeLocalStorage.setItem("concessions_dispatched_keys", JSON.stringify(dispatchedKeysRef.current));
      }
      if (dispatchDatesRef.current && Object.keys(dispatchDatesRef.current).length > 0) {
        safeLocalStorage.setItem("concessions_dispatch_dates", JSON.stringify(dispatchDatesRef.current));
      }
      if (dispatchByRef.current && Object.keys(dispatchByRef.current).length > 0) {
        safeLocalStorage.setItem("concessions_dispatch_by", JSON.stringify(dispatchByRef.current));
      }

      showToast("Switched to Offline Local Storage mode. Background sync paused.", "info");
    } else {
      // Switching from Offline back to Supabase Cloud -> Trigger Auto-Re-Sync
      setStorageMode("cloud");
      storageModeRef.current = "cloud";
      safeLocalStorage.setItem("app_storage_mode", "cloud");
      setIsSyncing(true);
      showToast("Reconnected to Cloud. Synchronizing local records to Supabase...", "info");

      try {
        const localPermitsStr = safeLocalStorage.getItem("concessions_permit_db");
        const localVouchersStr = safeLocalStorage.getItem("concessions_vouchers_db");
        const localDispatchedStr = safeLocalStorage.getItem("concessions_dispatched_keys");
        const localDatesStr = safeLocalStorage.getItem("concessions_dispatch_dates");
        const localByStr = safeLocalStorage.getItem("concessions_dispatch_by");

        let localPermits: CsvPermitRecord[] = [];
        let localVouchers: ParsedVoucherData[] = [];
        let localDispatchedKeys: string[] = [];
        let localDates: Record<string, string> = {};
        let localBy: Record<string, string> = {};

        try { if (localPermitsStr) localPermits = JSON.parse(localPermitsStr); } catch (e) {}
        try { if (localVouchersStr) localVouchers = JSON.parse(localVouchersStr); } catch (e) {}
        try { if (localDispatchedStr) localDispatchedKeys = JSON.parse(localDispatchedStr); } catch (e) {}
        try { if (localDatesStr) localDates = JSON.parse(localDatesStr); } catch (e) {}
        try { if (localByStr) localBy = JSON.parse(localByStr); } catch (e) {}

        // 1. Bulk sync local permits to Supabase if any exist, but NEVER overwrite newer cloud records with stale offline records
        if (localPermits.length > 0) {
          const existingCloudPermits = await fetchPermitsFromSupabase({ daysLimit: 365 });
          const existingCloudKeys = new Set(
            (existingCloudPermits || []).map(r => getNormalizedPermitKey(r)).filter(Boolean)
          );

          const brandNewLocalPermits = localPermits.filter(r => {
            const key = getNormalizedPermitKey(r);
            return key && !existingCloudKeys.has(key);
          });

          if (brandNewLocalPermits.length > 0) {
            await syncPermitsToSupabase(brandNewLocalPermits, false);
          }
        }

        // 2. Bulk sync local vouchers to Supabase if any exist
        if (localVouchers.length > 0) {
          await syncVouchersToSupabase(localVouchers, false);
        }

        // 3. Bulk sync local dispatched keys to Supabase
        if (localDispatchedKeys.length > 0) {
          const itemsToSync = localDispatchedKeys.map(k => ({
            key: k,
            dispatchedDate: localDates[k] || getTodayISO(),
            dispatchedBy: localBy[k] || currentUserName || 'System User'
          }));
          await bulkSyncDispatchedToSupabase(itemsToSync);
        }

        // 4. Refresh full state from cloud
        await refreshDatabase(undefined, false);
        showToast("Auto-sync complete! All offline records updated to Supabase Cloud.", "success");
      } catch (syncErr: any) {
        console.error("Auto-re-sync error:", syncErr);
        showToast(`Auto-sync warning: ${syncErr?.message || 'Could not sync all records'}`, "warning");
      } finally {
        setIsSyncing(false);
      }
    }
  }, [currentUserName, refreshDatabase, showToast]);

  const handlePurgeCorruptedKeys = useCallback(async () => {
    if (isSupabaseConfigured()) {
      const { count } = await cleanupCorruptedDispatchedKeys();
      console.log(`[Purge Keys] Cleaned ${count} corrupted collision keys`);
    }
    await refreshDatabase();
  }, [refreshDatabase]);

  const handleCleanDatabase = useCallback(async () => {
    showToast("Cleaning database...", "info");
    try {
      await handlePurgeCorruptedKeys();
      showToast("Database cleaned and synchronized successfully!", "success");
    } catch (e: any) {
      console.warn("Failed to clean database:", e);
      showToast("Failed to clean database.", "error");
    }
  }, [handlePurgeCorruptedKeys, showToast]);

  const handleDateRangeFilterChange = useCallback((newFilter: '7days' | '30days' | 'all') => {
    setDateRangeFilter(newFilter);
  }, []);

  const handleExportExcel = useCallback(async () => {
    let recordsToExport = databaseRef.current || database;
    if (isSupabaseConfigured() && !hasFullHistoryLoaded) {
      setIsLoadingHistory(true);
      try {
        const allPermits = await fetchPermitsFromSupabase({ daysLimit: null });
        if (allPermits && allPermits.length > 0) {
          const reconciled = autoCancelDuplicates(allPermits);
          recordsToExport = reconciled;
          setDatabase(reconciled);
          databaseRef.current = reconciled;
          setHasFullHistoryLoaded(true);
        }
      } catch (err) {
        console.warn("Export full history fetch failed, falling back to current memory database:", err);
      } finally {
        setIsLoadingHistory(false);
      }
    }
    try {
      const enrichedExport = enrichRecordsWithVouchers(
        recordsToExport,
        vouchersDatabaseRef.current || vouchersDatabase,
        customVouchersRef.current || customVouchers,
        formDataRef.current?.todayDate || getTodayISO()
      );
      exportToExcel(
        enrichedExport,
        "Concessions_Permits_Export.xlsx",
        customVouchersRef.current || customVouchers,
        formDataRef.current?.todayDate || getTodayISO()
      );
    } catch (e) {
      showToast("Export failed.", "error");
    }
  }, [database, hasFullHistoryLoaded, customVouchers, showToast]);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && storageModeRef.current === "cloud") {
        refreshDatabase(undefined, true);
      }
    };

    const initAndFetch = async () => {
      // If offline mode is active, ensure memory is hydrated and do not connect to Supabase
      if (storageModeRef.current === "offline") {
        if (!databaseRef.current || databaseRef.current.length === 0) {
          const localPermits = safeLocalStorage.getItem("concessions_permit_db");
          if (localPermits) {
            try {
              const parsed = JSON.parse(localPermits);
              const reconciled = Array.isArray(parsed) ? autoCancelDuplicates(parsed) : [];
              setDatabase(reconciled);
              databaseRef.current = reconciled;
              setTotalRecordsCount(reconciled.length);
            } catch (e) {}
          } else {
            const demoData = autoCancelDuplicates(parsePermitCsv(INITIAL_DEMO_CSV));
            setDatabase(demoData);
            databaseRef.current = demoData;
            setTotalRecordsCount(demoData.length);
          }
        } else {
          setTotalRecordsCount(databaseRef.current.length);
        }
        setIsSupabaseActive(false);
        initialSupabaseSyncDone.current = true;
        return;
      }

      await initSupabaseConfig();

      // One-time startup cleanup: remove only the known voucher codes that are
      // not present in the authoritative uploaded Vouchers.csv.
      if (isSupabaseConfigured()) {
        const { cleared } = await clearInvalidVoucherCodes();
        if (cleared > 0) {
          console.log(`Cleared ${cleared} invalid voucher codes`);
          window.location.reload();
          return;
        }
      }

      const configured = isSupabaseConfigured();
      if (!configured) {
        setIsSupabaseActive(false);
        initialSupabaseSyncDone.current = true;
        
        // Hydrate permits from LocalStorage only if not already hydrated on mount
        if (!databaseRef.current || databaseRef.current.length === 0) {
          const localPermits = safeLocalStorage.getItem("concessions_permit_db");
          if (localPermits) {
            try {
              const parsed = JSON.parse(localPermits);
              const reconciled = Array.isArray(parsed) ? autoCancelDuplicates(parsed) : [];
              setDatabase(reconciled);
              databaseRef.current = reconciled;
              setTotalRecordsCount(reconciled.length);
            } catch (e) {
              const demoData = autoCancelDuplicates(parsePermitCsv(INITIAL_DEMO_CSV));
              setDatabase(demoData);
              databaseRef.current = demoData;
              setTotalRecordsCount(demoData.length);
            }
          } else {
            const demoData = autoCancelDuplicates(parsePermitCsv(INITIAL_DEMO_CSV));
            setDatabase(demoData);
            databaseRef.current = demoData;
            setTotalRecordsCount(demoData.length);
          }
        } else {
          setTotalRecordsCount(databaseRef.current.length);
        }

        // Hydrate vouchers from LocalStorage immediately
        const localVouchersStr = safeLocalStorage.getItem("concessions_vouchers_db") || safeLocalStorage.getItem("vouchers") || safeLocalStorage.getItem("activeCodes");
        if (localVouchersStr) {
          try {
            const parsedVouchers = JSON.parse(localVouchersStr);
            if (Array.isArray(parsedVouchers)) {
              const sanitized = parsedVouchers.map((item: any) => ({
                ...item,
                code: item.code || item.VoucherCode || item.Code || "",
                status: item.status || "active",
                isUsed: item.isUsed !== undefined ? item.isUsed : false,
              })).filter((item: any) => item.code);
              setVouchersDatabase(sanitized);
              vouchersDatabaseRef.current = sanitized;
            }
          } catch (e) {}
        }
        return;
      }

      const conn = await checkSupabaseConnection();
      setIsSupabaseActive(conn.connected);

      if (conn.connected) {
        cleanupCorruptedDispatchedKeys().catch(e => console.warn("Cleanup key check failed:", e));
        await refreshDatabase(undefined, false);

        unsubscribe = subscribeToSupabaseChanges(() => {
          if (storageModeRef.current !== "cloud") return;
          if (Date.now() - lastUserActionTimestampRef.current < 2500) {
            return;
          }
          refreshDatabase(undefined, true);
        });

        // Safety reconciliation poll (5 minutes). Realtime subscriptions + visibilitychange provide instant updates.
        pollInterval = setInterval(() => {
          if (storageModeRef.current === "cloud" && document.visibilityState === 'visible') {
            refreshDatabase(undefined, true);
          }
        }, 300000);

        window.addEventListener("visibilitychange", handleVisibilityChange);
      } else {
        if (!databaseRef.current || databaseRef.current.length === 0) {
          const localPermits = safeLocalStorage.getItem("concessions_permit_db");
          if (localPermits) {
            try {
              const parsed = JSON.parse(localPermits);
              const reconciled = Array.isArray(parsed) ? autoCancelDuplicates(parsed) : [];
              setDatabase(reconciled);
              databaseRef.current = reconciled;
            } catch (e) {
              setDatabase(autoCancelDuplicates(parsePermitCsv(INITIAL_DEMO_CSV)));
            }
          } else {
            setDatabase(autoCancelDuplicates(parsePermitCsv(INITIAL_DEMO_CSV)));
          }
        }

        const localVouchersStr = safeLocalStorage.getItem("concessions_vouchers_db") || safeLocalStorage.getItem("vouchers") || safeLocalStorage.getItem("activeCodes");
        if (localVouchersStr) {
          try {
            const parsedVouchers = JSON.parse(localVouchersStr);
            if (Array.isArray(parsedVouchers)) {
              const sanitized = parsedVouchers.map((item: any) => ({
                ...item,
                code: item.code || item.VoucherCode || item.Code || "",
                status: item.status || "active",
                isUsed: item.isUsed !== undefined ? item.isUsed : false,
              })).filter((item: any) => item.code);
              setVouchersDatabase(sanitized);
              vouchersDatabaseRef.current = sanitized;
            }
          } catch (e) {}
        }
      }
      initialSupabaseSyncDone.current = true;
    };

    initAndFetch();

    return () => {
      if (unsubscribe) unsubscribe();
      if (pollInterval) clearInterval(pollInterval);
      window.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [storageMode]);

  const enrichedDatabase = React.useMemo(() => {
    return enrichRecordsWithVouchers(
      database,
      vouchersDatabase,
      customVouchers,
      formData.todayDate || getTodayISO()
    );
  }, [database, vouchersDatabase, customVouchers, formData.todayDate]);

  const isManualSelectionRef = useRef(false);
  const isUserNavigationRef = useRef(false);

  useEffect(() => {
    if (isManualSelectionRef.current) {
      isManualSelectionRef.current = false;
      isUserNavigationRef.current = false;
      setLastProcessedDate(formData.todayDate || getTodayISO());
      setLastDbLength(enrichedDatabase.length);
      return;
    }

    if (isSilentRefetchRef.current) {
      isSilentRefetchRef.current = false;
      setLastProcessedDate(formData.todayDate || getTodayISO());
      setLastDbLength(enrichedDatabase.length);
      return;
    }

    const activeDateStr = formData.todayDate || getTodayISO();
    if (!activeDateStr || !enrichedDatabase || enrichedDatabase.length === 0) {
      return;
    }

    const dateChanged = activeDateStr !== lastProcessedDate;
    const dbChanged = enrichedDatabase.length !== lastDbLength;
    const userNav = isUserNavigationRef.current;
    isUserNavigationRef.current = false;

    if (dateChanged || dbChanged || userNav) {
      setLastProcessedDate(activeDateStr);
      setLastDbLength(enrichedDatabase.length);

      const matching = getMatchingPermits(enrichedDatabase, activeDateStr);

      if (matching.length > 0) {
        const currentCleanVrm = (formData.vrm || "").toUpperCase().replace(/\s+/g, "");
        const currentCleanName = (formData.name || "").toUpperCase().replace(/\s+/g, "");
        const alreadyMatched = matching.find(r => 
          currentCleanVrm && r.vrm.toUpperCase().replace(/\s+/g, "") === currentCleanVrm &&
          (!currentCleanName || (r.driverName || "").toUpperCase().replace(/\s+/g, "") === currentCleanName)
        );

        if (alreadyMatched && !userNav) {
          return;
        }

        const firstUnsent = matching.find((item) => {
          return !checkIsRecordDispatched(item, item.vrm, item.driverName, item.dateRequired, dispatchedKeys, unsentKeys);
        });

        const targetRecord = firstUnsent || matching[0];

        const fromISO = parseDateToISO(targetRecord.dateRequired) || getTodayISO();
        const toISO = addDays(fromISO, 6);

        setFormData((prev) => {
          // If already pointing to the target record, don't trigger state update
          if (
            prev.id === targetRecord.id &&
            prev.vrm === (targetRecord.vrm ? targetRecord.vrm.toUpperCase() : "") &&
            prev.validFrom === fromISO
          ) {
            return prev;
          }
          return {
            ...prev,
            id: targetRecord.id,
            formId: targetRecord.formId || targetRecord.id,
            site: targetRecord.hospital,
            name: targetRecord.driverName ? toTitleCase(targetRecord.driverName) : "",
            vrm: targetRecord.vrm ? targetRecord.vrm.toUpperCase() : "",
            ward: targetRecord.ward ? toTitleCase(targetRecord.ward) : "",
            validFrom: fromISO,
            validTo: toISO,
            phone: formatPhoneNumber(targetRecord.phone || ""),
            email: (targetRecord.email || "").toLowerCase(),
            voucherCodesText: targetRecord.voucherCode || "-",
            startTime: targetRecord.startTime,
            createdAt: targetRecord.createdAt
          };
        });
      }
    }
  }, [formData.todayDate, enrichedDatabase.length, dispatchedKeys, unsentKeys, lastProcessedDate, lastDbLength]);

  const handleUpdate = useCallback((updates: Partial<PermitData>) => {
    setFormData((prev) => {
      let next = { ...prev, ...updates };

      const isRep = next.emailType === "RESEND_CONCESSION" ||
        next.isResend === true ||
        next.emailTemplate === "replacement" ||
        Boolean(next.replacementCode);

      if (isRep) {
        next.isResend = true;
        next.emailType = "RESEND_CONCESSION";
        next.emailTemplate = "replacement";
        if (!next.replacementCode && updates.voucherCodesText) {
          next.replacementCode = updates.voucherCodesText;
        }
      }

      if (updates.phone !== undefined) {
        next.phone = formatPhoneNumber(updates.phone);
      }

      if (updates.vrm !== undefined && updates.name === undefined) {
        const cleanVrm = updates.vrm.toUpperCase().replace(/\s+/g, "");
        if (cleanVrm) {
          const activeDateISO = parseDateToISO(next.todayDate || next.validFrom || "") || getTodayISO();
          const match = enrichedDatabase.find(r => {
            const rVrm = r.vrm ? r.vrm.toUpperCase().replace(/\s+/g, "") : "";
            const rDate = parseDateToISO(r.dateRequired || r.validFrom || "") || "";
            return rVrm === cleanVrm && (!rDate || rDate === activeDateISO);
          }) || enrichedDatabase.find(r => (r.vrm || "").toUpperCase().replace(/\s+/g, "") === cleanVrm);
          if (match) {
            const fromISO = parseDateToISO(match.dateRequired) || getTodayISO();
            const toISO = addDays(fromISO, 6);
            return {
              ...next,
              id: match.id || next.id,
              formId: match.formId || next.formId,
              site: match.hospital,
              name: match.driverName ? toTitleCase(match.driverName) : "",
              ward: match.ward ? toTitleCase(match.ward) : "",
              validFrom: fromISO,
              validTo: toISO,
              phone: formatPhoneNumber(match.phone || prev.phone || ""),
              email: (match.email || prev.email || "").toLowerCase(),
              voucherCodesText: match.voucherCode || prev.voucherCodesText || ""
            };
          }
        }
      }

      return next;
    });

    if (updates.voucherCodesText !== undefined) {
      const activeVrm = updates.vrm || formDataRef.current.vrm;
      const cleanVrm = activeVrm ? activeVrm.toUpperCase().replace(/\s+/g, "") : "";
      const activeDateISO = parseDateToISO(formDataRef.current.validFrom || formDataRef.current.todayDate || "") || getTodayISO();
      const targetId = String(updates.id || formDataRef.current.id || "").trim();
      const targetFormId = String(updates.formId || formDataRef.current.formId || "").trim();

      const candidateTarget = {
        id: updates.id || formDataRef.current.id,
        formId: updates.formId || formDataRef.current.formId,
        vrm: cleanVrm,
        validFrom: updates.validFrom || formDataRef.current.validFrom,
        dateRequired: updates.dateRequired || formDataRef.current.dateRequired,
        todayDate: updates.todayDate || formDataRef.current.todayDate || activeDateISO
      };

      if (cleanVrm || targetId || targetFormId) {
        const nextCustomVouchers = { ...customVouchersRef.current };
        if (targetFormId) {
          nextCustomVouchers[targetFormId] = updates.voucherCodesText || "";
        }
        if (targetId) {
          nextCustomVouchers[targetId] = updates.voucherCodesText || "";
        }
        // Only set keyWithDate if no stable ID exists and VRM is not a placeholder, preventing voucher collisions across records
        if (!targetId && !targetFormId && cleanVrm && !isPlaceholderVrm(cleanVrm) && activeDateISO) {
          const keyWithDate = `${cleanVrm}_${activeDateISO}`;
          nextCustomVouchers[keyWithDate] = updates.voucherCodesText || "";
        }
        setCustomVouchers(nextCustomVouchers);
        customVouchersRef.current = nextCustomVouchers;
        safeLocalStorage.setItem("concessions_custom_vouchers", JSON.stringify(nextCustomVouchers));
        const nowTimestamp = Date.now();
        safeLocalStorage.setItem("concessions_custom_vouchers_last_modified", String(nowTimestamp));

        const hasRep = updates.replacementCode !== undefined ||
          updates.emailType === "RESEND_CONCESSION" ||
          updates.isResend === true ||
          updates.emailTemplate === "replacement";

        setDatabase((prevDb) => {
          let matchedTarget = false;
          let hasRecordChanged = false;
          const nextDb = prevDb.map((rec) => {
            // Check match using canonical isRecordMatch utility
            const isMatch = isRecordMatch(rec, candidateTarget);

            // If ID/formId matched or first single matching record
            if (isMatch && (!matchedTarget || targetId || targetFormId)) {
              matchedTarget = true;
              const newVoucher = updates.voucherCodesText || rec.voucherCode || "";
              const newPrePaid = updates.voucherCodesText || rec.prePaidCode || "";
              const newStatus = updates.status || rec.status;
              const newRepCode = hasRep ? (updates.replacementCode || updates.voucherCodesText || rec.replacementCode) : rec.replacementCode;
              const newIsResend = hasRep ? true : rec.isResend;
              const newEmailType = hasRep ? "RESEND_CONCESSION" : rec.emailType;
              const newEmailTemplate = hasRep ? "replacement" : rec.emailTemplate;

              if (
                rec.voucherCode === newVoucher &&
                rec.prePaidCode === newPrePaid &&
                rec.status === newStatus &&
                rec.replacementCode === newRepCode &&
                rec.isResend === newIsResend &&
                rec.emailType === newEmailType &&
                rec.emailTemplate === newEmailTemplate
              ) {
                return rec;
              }

              hasRecordChanged = true;
              return {
                ...rec,
                voucherCode: newVoucher,
                prePaidCode: newPrePaid,
                status: newStatus,
                replacementCode: newRepCode,
                isResend: newIsResend,
                emailType: newEmailType,
                emailTemplate: newEmailTemplate
              };
            }

            return rec;
          });

          if (!hasRecordChanged || !matchedTarget) {
            return prevDb;
          }

          databaseRef.current = nextDb;
          safeLocalStorage.setItem("concessions_permit_db", JSON.stringify(nextDb));
          return nextDb;
        });

        // When a voucher code is changed or selected from Active Date Codes, reset this permit's STATUS to Pending
        const currentDb = databaseRef.current || [];
        const targetRecord = currentDb.find(r => isRecordMatch(r, candidateTarget));

        const keysToUnsent: string[] = [];
        if (targetRecord) {
          keysToUnsent.push(...getRecordKeys(targetRecord));
          const pk = getRecordPrimaryKey(targetRecord);
          if (pk) keysToUnsent.push(pk);
        }
        if (updates.id || formDataRef.current.id) {
          keysToUnsent.push(String(updates.id || formDataRef.current.id));
        }
        if (updates.formId || formDataRef.current.formId) {
          keysToUnsent.push(String(updates.formId || formDataRef.current.formId));
        }
        if (cleanVrm) {
          keysToUnsent.push(cleanVrm);
          if (activeDateISO) {
            keysToUnsent.push(`${cleanVrm}_${activeDateISO}`);
          }
          if (formDataRef.current.name || updates.name) {
            const nameStr = (updates.name || formDataRef.current.name || "").trim();
            keysToUnsent.push(`${nameStr}_${cleanVrm}_${activeDateISO}`.toUpperCase().replace(/[^A-Z0-9]/g, ""));
          }
        }

        const uniqueKeysToUnsent = Array.from(new Set(keysToUnsent.filter(Boolean)));
        if (uniqueKeysToUnsent.length > 0) {
          setUnsentKeys(prev => {
            const next = Array.from(new Set([...prev, ...uniqueKeysToUnsent]));
            if (next.length === prev.length) return prev;
            unsentKeysRef.current = next;
            return next;
          });
          setDispatchedKeys(prev => {
            const next = prev.filter(k => !uniqueKeysToUnsent.includes(k));
            if (next.length === prev.length) return prev;
            dispatchedKeysRef.current = next;
            return next;
          });
        }
      }
    }
  }, []);

  const handleProcessingDateChange = useCallback((dateISO: string) => {
    if (dateISO) {
      setFormData(prev => ({
        ...prev,
        todayDate: dateISO
      }));
    }
  }, []);

  const handleSelectRecord = useCallback((record: CsvPermitRecord) => {
    isManualSelectionRef.current = true;
    isUserNavigationRef.current = true;
    const sId = record.id !== undefined && record.id !== null ? String(record.id).trim() : "";
    const sFormId = record.formId !== undefined && record.formId !== null ? String(record.formId).trim() : "";
    const currentDb = databaseRef.current || [];
    const enrichedRecord = currentDb.find(r => {
      const rId = r.id !== undefined && r.id !== null ? String(r.id).trim() : "";
      const rFormId = r.formId !== undefined && r.formId !== null ? String(r.formId).trim() : "";
      return Boolean(
        (sId && rId === sId) ||
        (sFormId && rFormId === sFormId) ||
        (sId && rFormId === sId) ||
        (sFormId && rId === sId)
      );
    }) || record;
    const fromISO = getRequestedPermitDateISO(enrichedRecord) || parseDateToISO(enrichedRecord.validFrom || enrichedRecord.dateRequired) || getTodayISO();
    const toISO = enrichedRecord.validTo 
      ? (parseDateToISO(enrichedRecord.validTo) || addDays(fromISO, 6)) 
      : (enrichedRecord.dateExpiry ? (parseDateToISO(enrichedRecord.dateExpiry) || addDays(fromISO, 6)) : addDays(fromISO, 6));

    const isRecordDispatched = checkIsRecordDispatched(
      enrichedRecord,
      enrichedRecord.vrm,
      enrichedRecord.driverName,
      enrichedRecord.dateRequired,
      dispatchedKeysRef.current,
      unsentKeysRef.current
    );

    const isRepPending = Boolean(
      enrichedRecord.replacementCode ||
      enrichedRecord.emailType === "RESEND_CONCESSION" ||
      enrichedRecord.isResend ||
      enrichedRecord.emailTemplate === "replacement"
    );

    setFormData((prev) => ({
      ...prev,
      id: enrichedRecord.id,
      formId: enrichedRecord.formId || enrichedRecord.id,
      site: enrichedRecord.hospital,
      name: enrichedRecord.driverName ? toTitleCase(enrichedRecord.driverName) : "",
      vrm: enrichedRecord.vrm ? enrichedRecord.vrm.toUpperCase() : "",
      ward: enrichedRecord.ward ? toTitleCase(enrichedRecord.ward) : "",
      validFrom: fromISO,
      validTo: toISO,
      dateRequired: enrichedRecord.dateRequired || fromISO,
      todayDate: prev.todayDate || enrichedRecord.todayDate || getTodayISO(),
      phone: formatPhoneNumber(enrichedRecord.phone || ""),
      email: (enrichedRecord.email || "").toLowerCase(),
      voucherCodesText: isRepPending ? (enrichedRecord.replacementCode || enrichedRecord.voucherCode || "-") : (enrichedRecord.voucherCode || "-"),
      startTime: enrichedRecord.startTime,
      createdAt: enrichedRecord.createdAt,
      completionTime: enrichedRecord.completionTime,
      isCancelled: enrichedRecord.isCancelled,
      cancellationReason: enrichedRecord.cancellationReason,
      status: enrichedRecord.status,
      replacementCode: isRepPending ? enrichedRecord.replacementCode : undefined,
      isResend: isRepPending,
      emailType: isRepPending ? "RESEND_CONCESSION" : "SEND_CONCESSION",
      emailTemplate: isRepPending ? "replacement" : "new"
    }));
  }, []);

  const handleSelectRecordQuickSearch = useCallback((record: CsvPermitRecord) => {
    isManualSelectionRef.current = true;
    isUserNavigationRef.current = true;
    const sId = record.id !== undefined && record.id !== null ? String(record.id).trim() : "";
    const sFormId = record.formId !== undefined && record.formId !== null ? String(record.formId).trim() : "";
    const currentDb = databaseRef.current || [];
    const enrichedRecord = currentDb.find(r => {
      const rId = r.id !== undefined && r.id !== null ? String(r.id).trim() : "";
      const rFormId = r.formId !== undefined && r.formId !== null ? String(r.formId).trim() : "";
      return Boolean(
        (sId && rId === sId) ||
        (sFormId && rFormId === sFormId) ||
        (sId && rFormId === sId) ||
        (sFormId && rId === sId)
      );
    }) || record;
    const fromISO = getRequestedPermitDateISO(enrichedRecord) || parseDateToISO(enrichedRecord.validFrom || enrichedRecord.dateRequired) || getTodayISO();
    const toISO = enrichedRecord.validTo 
      ? (parseDateToISO(enrichedRecord.validTo) || addDays(fromISO, 6)) 
      : (enrichedRecord.dateExpiry ? (parseDateToISO(enrichedRecord.dateExpiry) || addDays(fromISO, 6)) : addDays(fromISO, 6));

    const isRecordDispatched = checkIsRecordDispatched(
      enrichedRecord,
      enrichedRecord.vrm,
      enrichedRecord.driverName,
      enrichedRecord.dateRequired,
      dispatchedKeysRef.current,
      unsentKeysRef.current
    );

    const isRepPendingQuick = Boolean(
      enrichedRecord.replacementCode ||
      enrichedRecord.emailType === "RESEND_CONCESSION" ||
      enrichedRecord.isResend ||
      enrichedRecord.emailTemplate === "replacement"
    );

    setFormData((prev) => ({
      ...prev,
      id: enrichedRecord.id,
      formId: enrichedRecord.formId || enrichedRecord.id,
      site: enrichedRecord.hospital,
      name: enrichedRecord.driverName ? toTitleCase(enrichedRecord.driverName) : "",
      vrm: enrichedRecord.vrm ? enrichedRecord.vrm.toUpperCase() : "",
      ward: enrichedRecord.ward ? toTitleCase(enrichedRecord.ward) : "",
      validFrom: fromISO,
      validTo: toISO,
      dateRequired: enrichedRecord.dateRequired || fromISO,
      todayDate: prev.todayDate || enrichedRecord.todayDate || getTodayISO(),
      phone: formatPhoneNumber(enrichedRecord.phone || ""),
      email: (enrichedRecord.email || "").toLowerCase(),
      voucherCodesText: isRepPendingQuick ? (enrichedRecord.replacementCode || enrichedRecord.voucherCode || "-") : (enrichedRecord.voucherCode || "-"),
      startTime: enrichedRecord.startTime,
      createdAt: enrichedRecord.createdAt,
      completionTime: enrichedRecord.completionTime,
      isCancelled: enrichedRecord.isCancelled,
      cancellationReason: enrichedRecord.cancellationReason,
      status: enrichedRecord.status,
      replacementCode: isRepPendingQuick ? enrichedRecord.replacementCode : undefined,
      isResend: isRepPendingQuick,
      emailType: isRepPendingQuick ? "RESEND_CONCESSION" : "SEND_CONCESSION",
      emailTemplate: isRepPendingQuick ? "replacement" : "new"
    }));
  }, []);

  const handlePreviewRecord = useCallback((record: CsvPermitRecord) => {
    handleSelectRecord(record);
    setIsPreviewCardOpen(true);
  }, [handleSelectRecord]);

  const handleEditRecord = useCallback((record: CsvPermitRecord, resolvedCode?: string) => {
    const recId = record.id !== undefined && record.id !== null ? String(record.id).trim() : "";
    const recFormId = record.formId !== undefined && record.formId !== null ? String(record.formId).trim() : "";
    const currentDb = databaseRef.current || [];

    const target = currentDb.find(r => {
      const rId = r.id !== undefined && r.id !== null ? String(r.id).trim() : "";
      const rFormId = r.formId !== undefined && r.formId !== null ? String(r.formId).trim() : "";
      return Boolean((recFormId && rFormId === recFormId) || (recId && rId === recId));
    }) || record;

    handleSelectRecord(target);
    const recordToEdit: CsvPermitRecord = {
      ...target,
      voucherCode: record.voucherCode || target.voucherCode,
      prePaidCode: record.prePaidCode || target.prePaidCode,
      status: record.status || target.status,
      isDispatched: record.isDispatched !== undefined ? record.isDispatched : target.isDispatched
    };
    setEditingRecord(recordToEdit);
    setEditingResolvedVoucherCode(resolvedCode || record.voucherCode || "");
    setIsEditModalOpen(true);
  }, [handleSelectRecord]);

  const handleSaveRecord = useCallback(async (updatedRecord: CsvPermitRecord) => {
    // Defense-in-depth: Validate changed voucher code using canonical Active Date Code rules
    if (editingRecord && updatedRecord.voucherCode) {
      const origCode = cleanVoucherCodeValue(
        editingResolvedVoucherCode ||
        editingRecord.voucherCode ||
        (editingRecord as any).prePaidCode ||
        ""
      ).trim().toUpperCase();

      const validation = validateManualVoucherChange({
        origCode,
        newCode: updatedRecord.voucherCode,
        permitDateRequired: updatedRecord.dateRequired || updatedRecord.validFrom || "",
        permitDateExpiry: updatedRecord.dateExpiry || updatedRecord.validTo || "",
        vouchersDatabase: vouchersDatabaseRef.current || []
      });

      if (!validation.isValid) {
        showToast(validation.error || "This voucher code is not valid for the selected permit date range.", "error");
        return;
      }
    }

    lastUserActionTimestampRef.current = Date.now();

    const currentDb = databaseRef.current || [];
    const previousRecord = currentDb.find(item => isRecordMatch(item, updatedRecord)) || null;

    let recordFound = false;
    const updatedDb = currentDb.map(item => {
      if (isRecordMatch(item, updatedRecord)) {
        recordFound = true;
        return { ...item, ...updatedRecord };
      }
      return item;
    });

    if (!recordFound) {
      updatedDb.push(updatedRecord);
    }

    const sorted = sortRecordsByFormIdDesc(updatedDb);
    const reconciled = autoCancelDuplicates(sorted);
    setDatabase(reconciled);
    databaseRef.current = reconciled;
    setTotalRecordsCount(prev => Math.max(prev, reconciled.length));

    safeLocalStorage.setItem("concessions_permit_db", JSON.stringify(reconciled));
    const nowTimestamp = Date.now();
    safeLocalStorage.setItem("concessions_permit_db_last_modified", String(nowTimestamp));

    // Persist custom voucher override if edited or replacement assigned
    if (updatedRecord.replacementCode !== undefined || updatedRecord.voucherCode !== undefined) {
      const cleanVrm = updatedRecord.vrm ? updatedRecord.vrm.toUpperCase().replace(/\s+/g, "") : "";
      const dateISO = parseDateToISO(updatedRecord.dateRequired || "") || getTodayISO();
      const codeVal = updatedRecord.replacementCode || updatedRecord.voucherCode || "-";

      const nextCustom = { ...customVouchersRef.current };
      if (updatedRecord.formId) nextCustom[String(updatedRecord.formId)] = codeVal;
      if (updatedRecord.id) nextCustom[String(updatedRecord.id)] = codeVal;
      if (cleanVrm && dateISO) nextCustom[`${cleanVrm}_${dateISO}`] = codeVal;
      if (cleanVrm) nextCustom[cleanVrm] = codeVal;

      setCustomVouchers(nextCustom);
      customVouchersRef.current = nextCustom;
      safeLocalStorage.setItem("concessions_custom_vouchers", JSON.stringify(nextCustom));
    }

    // ⭐ Asynchronous background persistence to Supabase with optimistic rollback on failure (with race safety)
    if (storageModeRef.current === "cloud" && isSupabaseConfigured()) {
      setIsSyncing(true);
      updatePermitInSupabase(updatedRecord)
        .then(cloudSuccess => {
          setIsSyncing(false);
          if (!cloudSuccess) {
            throw new Error("Supabase returned false on update");
          }
        })
        .catch(err => {
          setIsSyncing(false);
          console.error("Cloud persistence error (optimistic save failed):", err);
          showToast(`Failed to persist changes to Supabase: ${err?.message || 'Network error'}. Rolling back local change.`, "error");

          // Rollback safety check: ensure current database record still matches updatedRecord before rolling back
          const activeDb = databaseRef.current || [];
          const currentItem = activeDb.find(item => isRecordMatch(item, updatedRecord));
          const currentVoucher = currentItem?.voucherCode || (currentItem as any)?.prePaidCode;
          const targetVoucher = updatedRecord.voucherCode || (updatedRecord as any)?.prePaidCode;

          if (currentItem && currentVoucher === targetVoucher) {
            const rollbackDb = activeDb.map(item => {
              if (isRecordMatch(item, updatedRecord)) {
                return previousRecord ? { ...previousRecord } : item;
              }
              return item;
            });
            const sortedRollback = sortRecordsByFormIdDesc(rollbackDb);
            const reconciledRollback = autoCancelDuplicates(sortedRollback);
            setDatabase(reconciledRollback);
            databaseRef.current = reconciledRollback;
            safeLocalStorage.setItem("concessions_permit_db", JSON.stringify(reconciledRollback));
          }
        });
    }

    // Sync status with dispatch state
    const pk = getRecordPrimaryKey(updatedRecord);
    const keys = Array.from(new Set([pk, ...getRecordKeys(updatedRecord)].filter(Boolean)));
    if (updatedRecord.status === "SENT") {
      setDispatchedKeys(prev => Array.from(new Set([...prev, ...keys])));
      setUnsentKeys(prev => {
        const next = prev.filter(k => !keys.includes(k));
        if (next.length === prev.length) return prev;
        unsentKeysRef.current = next;
        return next;
      });
    } else if (updatedRecord.status === "UNSENT") {
      setUnsentKeys(prev => {
        const next = Array.from(new Set([...prev, ...keys]));
        if (next.length === prev.length) return prev;
        unsentKeysRef.current = next;
        return next;
      });
      setDispatchedKeys(prev => {
        const next = prev.filter(k => !keys.includes(k));
        if (next.length === prev.length) return prev;
        dispatchedKeysRef.current = next;
        return next;
      });
    } else if (updatedRecord.status === "PENDING") {
      setUnsentKeys(prev => {
        const next = prev.filter(k => !keys.includes(k));
        if (next.length === prev.length) return prev;
        unsentKeysRef.current = next;
        return next;
      });
      setDispatchedKeys(prev => {
        const next = prev.filter(k => !keys.includes(k));
        if (next.length === prev.length) return prev;
        dispatchedKeysRef.current = next;
        return next;
      });
    }

    // Update active permit formData if this edited record is currently loaded
    if (isRecordMatch(updatedRecord, formDataRef.current)) {
      const hasReplacement = Boolean(updatedRecord.replacementCode);
      setFormData(prev => ({
        ...prev,
        site: updatedRecord.hospital || prev.site,
        name: updatedRecord.driverName ? toTitleCase(updatedRecord.driverName) : (prev.name || ""),
        vrm: updatedRecord.vrm ? updatedRecord.vrm.toUpperCase() : (prev.vrm || ""),
        ward: updatedRecord.ward ? toTitleCase(updatedRecord.ward) : (prev.ward || ""),
        validFrom: updatedRecord.validFrom || updatedRecord.dateRequired || prev.validFrom,
        validTo: updatedRecord.validTo || updatedRecord.dateExpiry || prev.validTo,
        phone: formatPhoneNumber(updatedRecord.phone || ""),
        email: (updatedRecord.email || "").toLowerCase(),
        voucherCodesText: hasReplacement ? (updatedRecord.replacementCode || prev.voucherCodesText) : (updatedRecord.voucherCode || prev.voucherCodesText),
        status: updatedRecord.status,
        replacementCode: hasReplacement ? updatedRecord.replacementCode : undefined,
        isResend: hasReplacement,
        emailType: hasReplacement ? "RESEND_CONCESSION" : "SEND_CONCESSION",
        emailTemplate: hasReplacement ? "replacement" : "new"
      }));
    }

    showToast("Permit record updated successfully.", "success");
    setIsEditModalOpen(false);
    setEditingRecord(null);
    return true;
  }, [editingRecord, editingResolvedVoucherCode]);

  // ⭐ FIXED: reconcile incoming Excel records with the existing database BEFORE duplicate cancellation.
  // This is important when an older record was previously marked CANCELLED but a fresh Excel
  // import contains the same record in its original/active form. The earliest request must win.
  const handleDatabaseChange = useCallback(async (incomingDb: CsvPermitRecord[]) => {
    safeLocalStorage.removeItem("concessions_unsent_keys");
    clearDuplicateCheckCache();

    const incoming = Array.isArray(incomingDb) ? incomingDb : [];

    const getKey = (record: CsvPermitRecord): string => {
      const formId = record?.formId !== undefined && record?.formId !== null && record?.formId !== ""
        ? String(record.formId).trim()
        : "";
      const id = record?.id !== undefined && record?.id !== null && record?.id !== ""
        ? String(record.id).trim()
        : "";
      return formId || id;
    };

    // Merge by ID/formId. A fresh incoming active record replaces an existing CANCELLED copy;
    // otherwise preserve the existing edited record exactly as before.
    const mergedByKey = new Map<string, CsvPermitRecord>();
    const unkeyed: CsvPermitRecord[] = [];

    (databaseRef.current || []).forEach(existing => {
      const key = getKey(existing);
      if (key) mergedByKey.set(key, { ...existing });
      else unkeyed.push({ ...existing });
    });

    incoming.forEach(item => {
      const key = getKey(item);
      if (!key) {
        unkeyed.push({ ...item });
        return;
      }

      const existing = mergedByKey.get(key);
      const existingCancelled = existing?.isCancelled === true ||
        String(existing?.status || "").trim().toUpperCase() === "CANCELLED";
      const incomingCancelled = item?.isCancelled === true ||
        String(item?.status || "").trim().toUpperCase() === "CANCELLED";

      // Preserve any existing valid voucher code so an Excel upload does not wipe it out
      const preservedVoucher = (existing?.originalVoucherCode && existing.originalVoucherCode !== "CANCELLED" && existing.originalVoucherCode !== "-")
        ? existing.originalVoucherCode
        : (existing?.voucherCode && existing.voucherCode !== "CANCELLED" && existing.voucherCode !== "-")
          ? existing.voucherCode
          : undefined;

      if (!existing) {
        mergedByKey.set(key, { ...item });
      } else if (existingCancelled && !incomingCancelled) {
        // If the existing copy is cancelled but the source Excel row is active:
        // A genuinely cancelled record (MANUAL, BLOCKLIST, EXPIRED) must NEVER be automatically restored!
        const isGenuinelyCancelled =
          existing.cancellationReason === "MANUAL" ||
          existing.cancellationReason === "BLOCKLIST" ||
          existing.cancellationReason === "EXPIRED" ||
          isVrmSilentBlockedSync(existing.vrm);

        if (isGenuinelyCancelled) {
          mergedByKey.set(key, {
            ...item,
            ...existing,
            isCancelled: true,
            status: existing.status || "CANCELLED",
            voucherCode: existing.voucherCode || "CANCELLED",
            originalVoucherCode: preservedVoucher || existing.originalVoucherCode,
            cancellationReason: existing.cancellationReason
          });
        } else {
          // If the cancellation was caused by duplicate processing (or unprovenanced legacy), restore the
          // source row while preserving any genuine voucher code, and let autoCancelDuplicates evaluate winners.
          mergedByKey.set(key, {
            ...existing,
            ...item,
            voucherCode: preservedVoucher || item.voucherCode,
            originalVoucherCode: preservedVoucher || existing.originalVoucherCode,
            status: "ACTIVE",
            isCancelled: false,
            cancellationReason: undefined
          });
        }
      } else {
        // Retain existing edited version while merging any new fields from item
        mergedByKey.set(key, {
          ...item,
          ...existing,
          voucherCode: preservedVoucher || existing.voucherCode || item.voucherCode,
          originalVoucherCode: preservedVoucher || existing.originalVoucherCode,
        });
      }
    });

    const reconciled = [...Array.from(mergedByKey.values()), ...unkeyed];

    // ⭐ CRITICAL: run duplicate cancellation across the FULL reconciled database, not just
    // the newly uploaded rows. This catches cases where an older request was already stored
    // and a later duplicate was created by a subsequent submission.
    const processedRecords = autoCancelDuplicates(reconciled);

    const cancelledCount = processedRecords.filter(r =>
      String(r?.status || "").trim().toUpperCase() === "CANCELLED"
    ).length;

    if (cancelledCount > 0) {
      showToast(`✅ Processed ${processedRecords.length} records. ${cancelledCount} duplicate(s) auto-cancelled.`, "success");
      console.log(`🔄 Auto-cancelled ${cancelledCount} duplicate records`);
    }

    const sorted = sortRecordsByFormIdDesc(processedRecords);

    setDatabase(sorted);
    setTotalRecordsCount(prev => Math.max(prev, sorted.length));

    safeLocalStorage.setItem("concessions_permit_db", JSON.stringify(sorted));
    const nowTimestamp = Date.now();
    safeLocalStorage.setItem("concessions_permit_db_last_modified", String(nowTimestamp));

    if (storageModeRef.current === "cloud" && isSupabaseConfigured()) {
      await syncPermitsToSupabase(sorted, false);
      await refreshDatabase(undefined, true);
    }

    if (processedRecords && processedRecords.length > 0) {
      const firstRecord = processedRecords[0];
      const fromISO = parseDateToISO(firstRecord.dateRequired) || getTodayISO();
      const toISO = addDays(fromISO, 6);

      setFormData((prev) => ({
        ...prev,
        site: firstRecord.hospital,
        name: firstRecord.driverName ? toTitleCase(firstRecord.driverName) : "",
        vrm: firstRecord.vrm ? firstRecord.vrm.toUpperCase() : "",
        ward: firstRecord.ward ? toTitleCase(firstRecord.ward) : "",
        validFrom: fromISO,
        validTo: toISO,
        phone: formatPhoneNumber(firstRecord.phone || prev.phone || ""),
        email: (firstRecord.email || prev.email || "").toLowerCase(),
        voucherCodesText: firstRecord.voucherCode || prev.voucherCodesText || ""
      }));
    }
  }, [refreshDatabase]);

  const handleVouchersDatabaseChange = useCallback(async (incomingVouchers: ParsedVoucherData[]) => {
    clearDuplicateCheckCache();
    // ⭐ FIX: Clear any customVouchers entries whose codes no longer exist in incoming vouchers
    const validCodes = new Set(
      (incomingVouchers || [])
        .filter(v => v && v.code)
        .map(v => cleanVoucherCodeValue(v.code).toUpperCase())
    );

    const currentCustom = customVouchersRef.current || {};
    const cleanedCustomVouchers: Record<string, string> = {};
    Object.entries(currentCustom).forEach(([key, raw]) => {
      if (raw && typeof raw === "string") {
        const clean = cleanVoucherCodeValue(raw).toUpperCase();
        if (validCodes.has(clean)) {
          cleanedCustomVouchers[key] = raw;
        }
      }
    });

    if (Object.keys(cleanedCustomVouchers).length !== Object.keys(currentCustom).length) {
      setCustomVouchers(cleanedCustomVouchers);
      customVouchersRef.current = cleanedCustomVouchers;
      safeLocalStorage.setItem("concessions_custom_vouchers", JSON.stringify(cleanedCustomVouchers));
    }

    const mergedMap = new Map<string, ParsedVoucherData>();
    const todayISO = getTodayISO();

    (vouchersDatabaseRef.current || []).forEach(v => {
      if (!v.code) return;
      const cleanKey = cleanVoucherCodeValue(v.code).toUpperCase();
      if (cleanKey && cleanKey !== "-") {
        mergedMap.set(cleanKey, { ...v });
      }
    });

    (incomingVouchers || []).forEach(v => {
      if (!v.code) return;
      const cleanKey = cleanVoucherCodeValue(v.code).toUpperCase();
      if (cleanKey && cleanKey !== "-") {
        const existing = mergedMap.get(cleanKey);
        const effectiveValidFrom = v.validFrom || (existing ? existing.validFrom : undefined);
        const effectiveValidTo = v.validTo || (existing ? existing.validTo : undefined) || (effectiveValidFrom ? addDaysSafe(effectiveValidFrom, 6) : undefined);
        if (existing) {
          mergedMap.set(cleanKey, {
            ...existing,
            ...v,
            vrm: v.vrm || existing.vrm,
            validFrom: effectiveValidFrom,
            validTo: effectiveValidTo,
            valid_from: effectiveValidFrom,
            valid_to: effectiveValidTo,
            uploadDate: v.uploadDate || existing.uploadDate || todayISO
          });
        } else {
          mergedMap.set(cleanKey, {
            ...v,
            validFrom: effectiveValidFrom,
            validTo: effectiveValidTo,
            valid_from: effectiveValidFrom,
            valid_to: effectiveValidTo,
            uploadDate: v.uploadDate || todayISO
          });
        }
      }
    });

    const combinedVouchers = Array.from(mergedMap.values());
    setVouchersDatabase(combinedVouchers);
    vouchersDatabaseRef.current = combinedVouchers;

    safeLocalStorage.setItem("concessions_vouchers_db", JSON.stringify(combinedVouchers));
    const nowTimestamp = Date.now();
    safeLocalStorage.setItem("concessions_vouchers_db_last_modified", String(nowTimestamp));

    if (storageModeRef.current === "cloud" && isSupabaseConfigured()) {
      await syncVouchersToSupabase(combinedVouchers, false);
      await refreshDatabase(undefined, true);
    }
  }, [refreshDatabase]);

  const handleResetVouchers = useCallback(async (): Promise<{ cleared: number; error: string | null }> => {
    console.log('CLEAR ALL VOUCHERS STARTED');
    showToast("Resetting voucher inventory...", "info");

    let result = { cleared: 0, error: null as string | null };
    if (isSupabaseConfigured()) {
      result = await resetVoucherInventory();
    }

    setVouchersDatabase([]);
    vouchersDatabaseRef.current = [];

    safeLocalStorage.removeItem("concessions_vouchers_db");
    safeLocalStorage.removeItem("vouchers");
    safeLocalStorage.removeItem("activeCodes");
    safeLocalStorage.removeItem("concessions_vouchers_db_last_modified");
    safeLocalStorage.removeItem("concessions_uploaded_vouchers_file_name");
    try {
      sessionStorage.removeItem("concessions_vouchers_db");
      sessionStorage.removeItem("vouchers");
      sessionStorage.removeItem("activeCodes");
    } catch (e) {}

    showToast("Voucher inventory reset to 0.", "success");
    return result;
  }, [showToast]);

  useEffect(() => {
    (window as any).resetVoucherInventory = handleResetVouchers;
    (window as any).clearAllVouchers = handleResetVouchers;
  }, [handleResetVouchers]);

  const handleClear = useCallback(() => {
    setFormData({
      title: "Patient & Visitor Concessions",
      site: "",
      name: "",
      vrm: "",
      validFrom: "",
      validTo: "",
      ward: "",
      qrOverride: "",
      voucherCodesText: "",
      phone: "",
      email: "",
      todayDate: ""
    });
  }, []);

  const handleHeaderSend = useCallback(async () => {
    if (!formDataRef.current.vrm) {
      showToast("Select a permit record first.", "warning");
      return;
    }
    await permitCardRef.current?.send();
  }, [showToast]);

  const handleBulkEmail = useCallback(async () => {
    await permitCardRef.current?.bulkEmail();
  }, []);

  const handleHeaderPrint = useCallback(() => {
    if (!formDataRef.current.vrm) {
      showToast("Select a permit record first.", "warning");
      return;
    }
    permitCardRef.current?.print();
  }, [showToast]);

  const handleResendRecord = useCallback(async (record: CsvPermitRecord) => {
    // 1. Identify or generate genuine new voucher code
    const currentForm = formDataRef.current;
    let newVoucherCode = (record.replacementCode || (isRecordMatch(record, currentForm) ? currentForm.replacementCode : "") || "").trim().toUpperCase();
    if (!newVoucherCode || newVoucherCode === "-" || newVoucherCode === "CANCELLED" || newVoucherCode === "PENDING") {
      // Find an unused voucher in vouchersDatabase
      const availableUnused = (vouchersDatabaseRef.current || []).find(v => {
        if (!v || !v.code || v.isUsed) return false;
        const clean = cleanVoucherCodeValue(v.code).toUpperCase();
        if (!clean || clean === "-" || clean === "CANCELLED" || clean === "PENDING") return false;
        const inUse = (databaseRef.current || []).some(r => !isRecordMatch(r, record) && isVoucherCodeMatch(r.voucherCode, clean));
        return !inUse;
      });

      if (availableUnused && availableUnused.code) {
        newVoucherCode = cleanVoucherCodeValue(availableUnused.code).toUpperCase();
        setVouchersDatabase(prev => {
          const next = prev.map(v => v.code === availableUnused.code ? { ...v, isUsed: true } : v);
          vouchersDatabaseRef.current = next;
          safeLocalStorage.setItem("concessions_vouchers_db", JSON.stringify(next));
          return next;
        });
      } else {
        // Auto-generate genuine alphanumeric concession voucher code
        const chars = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
        let rand = "";
        for (let i = 0; i < 10; i++) {
          rand += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        newVoucherCode = `NHS${rand}`;
      }
    }

    // 2. Call backend /api/emails/resend to create tracking record & pixel
    const pk = getRecordPrimaryKey(record) || record.vrm || String(record.id || "");
    const normVrm = (record.vrm || "").toUpperCase().replace(/\s+/g, "");
    let trackingId = "";

    try {
      const res = await fetch("/api/emails/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recordKey: pk,
          vrm: record.vrm,
          driverName: record.driverName,
          email: record.email,
          requestedCode: newVoucherCode,
          validFrom: record.validFrom || record.dateRequired,
          validTo: record.validTo,
          todayDate: record.todayDate || currentForm.todayDate || getTodayISO()
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.voucherCode) newVoucherCode = data.voucherCode;
        trackingId = data.trackingId;
      }
    } catch (e) {
      console.warn("Backend resend call failed, falling back to local tracking:", e);
      trackingId = `trk_${Date.now()}`;
    }

    const sentAt = new Date().toISOString();

    // 3. Immediately update emailTracking state so the badge changes to SENT right away
    setEmailTracking(prev => {
      const next = { ...prev };
      const info: EmailTrackingInfo = {
        status: "SENT",
        sentAt,
        trackingId
      };
      if (pk) next[pk] = info;
      if (normVrm) next[normVrm] = info;
      if (record.formId) next[String(record.formId)] = info;
      if (record.id) next[String(record.id)] = info;
      safeLocalStorage.setItem("concessions_email_tracking", JSON.stringify(next));
      return next;
    });

    // 4. Update the record in database: assign newVoucherCode, clear replacement flags, mark SENT
    const originalCode = record.voucherCode || record.prePaidCode || record.originalVoucherCode;
    const updatedRecord: CsvPermitRecord = {
      ...record,
      voucherCode: newVoucherCode,
      voucherCodesText: newVoucherCode,
      prePaidCode: newVoucherCode,
      originalVoucherCode: originalCode,
      replacementCode: undefined,
      isResend: false,
      emailType: undefined,
      emailTemplate: undefined,
      status: "SENT",
      isDispatched: true
    };

    setDatabase(prevDb => {
      const nextDb = prevDb.map(item => isRecordMatch(item, record) ? updatedRecord : item);
      databaseRef.current = nextDb;
      safeLocalStorage.setItem("concessions_permit_db", JSON.stringify(nextDb));
      if (storageModeRef.current === "cloud" && isSupabaseConfigured()) {
        updatePermitInSupabase(updatedRecord).catch(e => console.error("Targeted permit update after resend failed:", e));
      }
      return nextDb;
    });

    // 5. Update customVouchers map so new code is preserved
    setCustomVouchers(prev => {
      const next = { ...prev };
      if (record.formId) next[String(record.formId)] = newVoucherCode;
      if (record.id) next[String(record.id)] = newVoucherCode;
      if (normVrm) {
        const dateISO = parseDateToISO(record.dateRequired || record.validFrom || "") || getTodayISO();
        next[normVrm] = newVoucherCode;
        if (dateISO) next[`${normVrm}_${dateISO}`] = newVoucherCode;
      }
      safeLocalStorage.setItem("concessions_custom_vouchers", JSON.stringify(next));
      return next;
    });

    // 6. Mark dispatched
    await markAsDispatched(record.vrm, record.email, updatedRecord);

    // 7. Update formData with resent state
    setFormData(prev => ({
      ...prev,
      id: updatedRecord.id,
      formId: updatedRecord.formId,
      vrm: updatedRecord.vrm,
      voucherCodesText: newVoucherCode,
      replacementCode: undefined,
      isResend: true,
      emailType: "RESEND_CONCESSION",
      emailTemplate: "replacement",
      status: "SENT"
    }));

    // 8. Open email composer with the new code & tracking pixel (skip redundant dispatch)
    handleSelectRecord(updatedRecord);
    if (permitCardRef.current?.sendOne) {
      await permitCardRef.current.sendOne(updatedRecord, { skipDispatch: true, isReplacement: true });
    }

    showToast(`✅ Replacement permit resent with new code ${newVoucherCode}. Status updated to SENT.`, "success");
  }, [markAsDispatched, handleSelectRecord, showToast]);

  const handleDispatchRecord = useCallback(async (record: CsvPermitRecord) => {
    const currentForm = formDataRef.current;
    const isRep = Boolean(
      record.replacementCode ||
      record.emailType === "RESEND_CONCESSION" ||
      record.isResend ||
      record.emailTemplate === "replacement" ||
      (isRecordMatch(record, currentForm) && (currentForm.isResend || currentForm.replacementCode || currentForm.emailType === "RESEND_CONCESSION"))
    );
    if (isRep) {
      return handleResendRecord(record);
    }

    handleSelectRecord(record);
    if (permitCardRef.current?.sendOne) {
      await permitCardRef.current.sendOne(record);
    } else if (permitCardRef.current?.send) {
      await permitCardRef.current.send(record);
    } else {
      await markAsDispatched(record.vrm, record.email, record);
    }
  }, [handleResendRecord, handleSelectRecord, markAsDispatched]);

  const handleUnsendRecord = useCallback(async (record: CsvPermitRecord) => {
    handleSelectRecord(record);
    if (permitCardRef.current?.unsend) {
      await permitCardRef.current.unsend(record);
    } else {
      await unmarkAsDispatched(record.vrm, record.email, record);
    }
  }, [handleSelectRecord, unmarkAsDispatched]);

  const handleBrowseConcessions = useCallback(() => {
    csvPanelRef.current?.browseConcessions();
  }, []);

  const handleBrowseVouchers = useCallback(() => {
    csvPanelRef.current?.browseVouchers();
  }, []);

  const handleOpenBlocklist = useCallback(() => {
    setShowBlocklist(true);
  }, []);

  const dispatchedCount = useMemo(() => {
    return enrichedDatabase.filter(record => 
      checkIsRecordDispatched(record, record.vrm, record.driverName, record.dateRequired, dispatchedKeys, unsentKeys)
    ).length;
  }, [enrichedDatabase, dispatchedKeys, unsentKeys]);

  return (
    <div className="park-app" id="print-root-container">
      <style>{`@media print { body { background:#fff !important; } .no-print, .data-sidebar, .form-panel, .dispatch-panel, .park-view-tabs { display:none !important; } #print-card-wrapper { display:block !important; position:fixed !important; inset:0 !important; margin:auto !important; width:370px !important; height:max-content !important; } #print-card-content { box-shadow:none !important; } }`}</style>
      {syncToast && (
        <div className={`park-toast ${syncToast.type}`}>
          {syncToast.type === "success" ? <CheckCircle2 /> : <AlertCircle />}
          <span>{syncToast.message}</span>
        </div>
      )}

      <Header
        darkMode={darkMode}
        onToggleDarkMode={handleToggleDarkMode}
        activeTab={activeTab}
        onActiveTabChange={setActiveTab}
        onExportExcel={handleExportExcel}
        onCleanDatabase={handleCleanDatabase}
        onOpenBlocklist={handleOpenBlocklist}
        storageMode={storageMode}
        onToggleStorageMode={handleToggleStorageMode}
        isSyncing={isSyncing}
        onSyncNow={handleManualSync}
        totalRecordsCount={totalRecordsCount > 0 ? totalRecordsCount : enrichedDatabase.length}
        dispatchedCount={dispatchedCount}
        vouchersCount={vouchersDatabase.length}
        onOutlook={handleHeaderSend}
        onEmail={handleHeaderSend}
        onPrint={handleHeaderPrint}
      />

      {activeTab === "dispatcher" && (
        <main className="w-full flex flex-col gap-4">
          <CsvDatabasePanel
            ref={csvPanelRef}
            database={enrichedDatabase}
            totalRecordsCount={totalRecordsCount > 0 ? totalRecordsCount : enrichedDatabase.length}
            onDatabaseChange={handleDatabaseChange}
            vouchersDatabase={vouchersDatabase}
            onVouchersDatabaseChange={handleVouchersDatabaseChange}
            onSelectRecord={handleSelectRecordQuickSearch}
            onRefreshDatabase={refreshDatabase}
            dispatchedKeys={dispatchedKeys}
            dispatchDates={dispatchDates}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            dateRangeFilter={dateRangeFilter}
            onDateRangeFilterChange={handleDateRangeFilterChange}
            isLoadingHistory={isLoadingHistory}
            processingDate={formData.todayDate || getTodayISO()}
            onProcessingDateChange={handleProcessingDateChange}
            customVouchersMap={customVouchers}
          />

          <DispatchCentre
            database={enrichedDatabase}
            vouchersDatabase={vouchersDatabase}
            dispatchedKeys={dispatchedKeys}
            unsentKeys={unsentKeys}
            dispatchDates={dispatchDates}
            customVouchers={customVouchers}
            processingDate={formData.todayDate || getTodayISO()}
            formData={formData}
            totalRecordsCount={totalRecordsCount > 0 ? totalRecordsCount : enrichedDatabase.length}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onSelectRecord={handleSelectRecord}
            onSendRecord={handleDispatchRecord}
            onUnsendRecord={handleUnsendRecord}
            onResendRecord={handleResendRecord}
            emailTracking={emailTracking}
            onBulkEmail={handleBulkEmail}
            onClear={handleClear}
            onChangeFormData={handleUpdate}
            dateRangeFilter={dateRangeFilter}
            onDateRangeFilterChange={handleDateRangeFilterChange}
            isLoadingHistory={isLoadingHistory}
            onBrowseConcessions={handleBrowseConcessions}
            onBrowseVouchers={handleBrowseVouchers}
            onResetVouchers={handleResetVouchers}
            onEditRecord={handleEditRecord}
            onPreviewRecord={handlePreviewRecord}
          />

          <HiddenPermitCardEngine
            cardRef={permitCardRef}
            data={formData}
            database={enrichedDatabase}
            vouchersDatabase={vouchersDatabase}
            dispatchedKeys={dispatchedKeys}
            unsentKeys={unsentKeys}
            dispatchBy={dispatchBy}
            markAsDispatched={markAsDispatched}
            unmarkAsDispatched={unmarkAsDispatched}
            onSelectRecord={handleSelectRecord}
            onChange={handleUpdate}
          />
        </main>
      )}

      {/* Permit Card Modal Preview */}
      {isPreviewCardOpen && (
        <div 
          className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 animate-fadeIn"
          onClick={() => setIsPreviewCardOpen(false)}
        >
          <div 
            className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl w-full max-w-[402px] p-4 flex flex-col items-center text-left my-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="w-full flex items-center justify-between pb-3 mb-3 border-b border-slate-200 dark:border-slate-800 select-none">
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-sm text-slate-900 dark:text-white">Permit Card Preview</span>
                {formData.vrm && (
                  <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950/50 text-amber-950 dark:text-amber-300 border border-yellow-200 dark:border-yellow-900/50 uppercase">
                    {formData.vrm}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setIsPreviewCardOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                title="Close preview (Esc)"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* The Actual PermitCard Visual Component */}
            <div className="w-full flex justify-center">
              <PermitCard
                previewOnly={true}
                data={formData}
                database={enrichedDatabase}
                vouchersDatabase={vouchersDatabase}
                dispatchedKeys={dispatchedKeys}
                unsentKeys={unsentKeys}
                dispatchBy={dispatchBy}
                markAsDispatched={markAsDispatched}
                unmarkAsDispatched={unmarkAsDispatched}
                onSelectRecord={handleSelectRecord}
                onChange={handleUpdate}
              />
            </div>
          </div>
        </div>
      )}

      {/* Blocklist Management Modal Panel */}
      <BlocklistPanel 
        isOpen={showBlocklist} 
        onClose={() => setShowBlocklist(false)} 
        database={enrichedDatabase}
      />

      {/* Edit Permit Record Modal */}
      <EditRecordModal
        isOpen={isEditModalOpen}
        record={editingRecord}
        resolvedVoucherCode={editingResolvedVoucherCode}
        database={enrichedDatabase}
        vouchersDatabase={vouchersDatabase}
        dispatchedKeys={dispatchedKeys}
        onClose={() => {
          setIsEditModalOpen(false);
          setEditingRecord(null);
          setEditingResolvedVoucherCode("");
        }}
        onSave={handleSaveRecord}
        onChangeFormData={handleUpdate}
      />
    </div>
  );
}