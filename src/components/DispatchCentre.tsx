import React, { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useTableVirtualizer } from "../utils/useTableVirtualizer";
import { 
  ChevronDown, 
  ChevronLeft,
  ChevronRight,
  Mail, 
  Send, 
  Navigation,
  Archive, 
  Zap, 
  XSquare, 
  Calendar, 
  Building2, 
  Database, 
  CheckCircle2, 
  Lock, 
  RefreshCw,
  Download,
  QrCode,
  Search,
  X,
  Filter,
  FileSpreadsheet,
  FileText,
  Pencil,
  Eye,
  User
} from "lucide-react";
import { 
  CsvPermitRecord, 
  ParsedVoucherData, 
  parseDateToISO, 
  parseDateRange,
  addDays, 
  getSpreadsheetMatchingAllocationsMap, 
  isDateRequiredOutsideValidWindow, 
  checkIsBlockedDuplicate,
  exportToExcel,
  isRecordCancelled,
  sortRecordsByFormIdDesc,
  getNumericFormId,
  extractRecordSubmissionTimeMs,
  getRequestedPermitDateISO,
  getRecordSubmittedDateISO,
  getTodayISO,
  formatSubmittedDateTime,
  getRecordSubmittedTimeMs,
  getUnusedVouchersForDate,
  getSpreadsheetMatchingAssignedCodes,
  getVoucherDateISO,
  cleanVoucherCodeValue,
  isVoucherCodeMatch,
  isVoucherInValidityPeriod,
  toTitleCase,
  isValidVRM,
  isLikelyDriverName,
  cleanVrm,
  safeParseDateToTimestamp,
  safeParseDMYToISO
} from "../utils/csvParser";
import { checkIsRecordDispatched, isRecordMatch, isPlaceholderVrm, getRecordPrimaryKey } from "../utils/dispatchUtils";
import { isVrmSilentBlockedSync } from "../lib/blocklist";
// ⭐ FIX: Import canonical date & voucher matching functions from voucherValidation
import {
  isVoucherForPermitDateRange,
  getVoucherValidFromISO,
  getVoucherValidToISO,
  normalizeDateToISO,
  addDaysISO,
  computeVoucherBatchExpiryBadge,
  getSelectableActiveDateCodes,
  buildAssignedCodeSet
} from "../utils/voucherValidation";

// ⭐ FIX: Re-export helper functions so other files importing from DispatchCentre don't break
export { isVoucherForPermitDateRange, getSelectableActiveDateCodes };

interface DispatchCentreProps {
  database: CsvPermitRecord[];
  vouchersDatabase: ParsedVoucherData[];
  dispatchedKeys: string[];
  unsentKeys?: string[];
  dispatchDates?: Record<string, string>;
  customVouchers?: Record<string, string>;
  processingDate: string;
  formData?: {
    todayDate?: string;
    validFrom?: string;
    validTo?: string;
    ward?: string;
    hospitalSite?: string;
    [key: string]: any;
  };
  totalRecordsCount?: number;
  searchQuery?: string;
  onSearchQueryChange?: (query: string) => void;
  onSelectRecord: (record: CsvPermitRecord) => void;
  onSendRecord?: (record: CsvPermitRecord) => Promise<void> | void;
  onUnsendRecord?: (record: CsvPermitRecord) => Promise<void> | void;
  onBulkEmail?: () => void;
  onClear?: () => void;
  onChangeFormData?: (updates: any) => void;
  dateRangeFilter?: '7days' | '30days' | 'all';
  onDateRangeFilterChange?: (filter: '7days' | '30days' | 'all') => void;
  isLoadingHistory?: boolean;
  onBrowseConcessions?: () => void;
  onBrowseVouchers?: () => void;
  onResetVouchers?: () => Promise<any> | void;
  onEditRecord?: (record: CsvPermitRecord, resolvedCode?: string) => void;
  onResendRecord?: (record: CsvPermitRecord) => Promise<void> | void;
  onPreviewRecord?: (record: CsvPermitRecord) => void;
  emailTracking?: Record<string, { status: "SENT"; sentAt?: string; trackingId?: string }>;
}

const formatDate = (dateStr?: any) => {
  if (!dateStr) return "-";
  const s = String(dateStr).trim();
  if (!s || s === "-" || s === "—" || s.toLowerCase() === "null" || s.toLowerCase() === "undefined") return "-";
  const iso = parseDateToISO(s);
  if (!iso) return s;
  const parts = iso.split("-");
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return s;
};

export type SortKey = 
  | "id" 
  | "submitted"
  | "qr" 
  | "driverName" 
  | "vrm" 
  | "voucherCode" 
  | "validFrom" 
  | "validTo" 
  | "ward" 
  | "hospital" 
  | "status" 
  | "actions";

export type SortDirection = "asc" | "desc" | null;

function DispatchCentreComponent({ 
  database, 
  vouchersDatabase, 
  dispatchedKeys, 
  unsentKeys = [], 
  dispatchDates,
  customVouchers,
  processingDate, 
  formData,
  totalRecordsCount,
  searchQuery: searchQueryProp,
  onSearchQueryChange,
  onSelectRecord, 
  onSendRecord, 
  onUnsendRecord, 
  onBulkEmail,
  onClear,
  onChangeFormData,
  dateRangeFilter,
  onDateRangeFilterChange,
  isLoadingHistory,
  onBrowseConcessions,
  onBrowseVouchers,
  onResetVouchers,
  onEditRecord,
  onResendRecord,
  onPreviewRecord,
  emailTracking = {}
}: DispatchCentreProps) {
  const isControlled = searchQueryProp !== undefined;
  const initialSearch = isControlled ? (searchQueryProp || "") : "";
  const [localSearchInput, setLocalSearchInput] = useState(initialSearch);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(initialSearch);

  // Memoized Sets for fast O(1) dispatch checks across large datasets (~2,000+ records)
  const dispatchedKeysSet = useMemo(
    () => new Set(dispatchedKeys || []),
    [dispatchedKeys]
  );

  const unsentKeysSet = useMemo(
    () => new Set(unsentKeys || []),
    [unsentKeys]
  );

  // Sync local and debounced input when external searchQueryProp changes
  useEffect(() => {
    if (searchQueryProp !== undefined && searchQueryProp !== localSearchInput) {
      setLocalSearchInput(searchQueryProp);
      setDebouncedSearchQuery(searchQueryProp);
    }
  }, [searchQueryProp]);

  // 150ms debounce for filtering/search state update
  useEffect(() => {
    if (localSearchInput === debouncedSearchQuery) return;
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(localSearchInput);
      if (isControlled && onSearchQueryChange) {
        if (searchQueryProp !== localSearchInput) {
          onSearchQueryChange(localSearchInput);
        }
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [localSearchInput, debouncedSearchQuery, isControlled, onSearchQueryChange, searchQueryProp]);

  const handleSearchChange = (val: string) => {
    setLocalSearchInput(val);
    // Immediate clear support
    if (!val) {
      setDebouncedSearchQuery("");
      if (isControlled && onSearchQueryChange) {
        onSearchQueryChange("");
      }
    }
  };

  const searchQuery = debouncedSearchQuery;

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [wardDropdownOpen, setWardDropdownOpen] = useState(false);
  const [selectedRowRecord, setSelectedRowRecord] = useState<CsvPermitRecord | null>(null);
  const [isReplacingCode, setIsReplacingCode] = useState(false);

  // Sync selectedRowRecord when replacement code is assigned or cleared
  useEffect(() => {
    const isRep = (formData?.emailType === "RESEND_CONCESSION" || formData?.isResend || Boolean(formData?.replacementCode) || formData?.emailTemplate === "replacement") && formData?.status !== "SENT";
    if (isRep && (formData?.voucherCodesText || formData?.replacementCode)) {
      const repCode = formData.replacementCode || formData.voucherCodesText;
      setSelectedRowRecord(prev => {
        if (prev) {
          return {
            ...prev,
            replacementCode: repCode || prev.replacementCode,
            isResend: true,
            emailType: "RESEND_CONCESSION",
            emailTemplate: "replacement"
          };
        }
        if (database) {
          const match = database.find(r => isRecordMatch(r, formData));
          if (match) {
            return {
              ...match,
              replacementCode: repCode || match.replacementCode,
              isResend: true,
              emailType: "RESEND_CONCESSION",
              emailTemplate: "replacement"
            };
          }
        }
        return null;
      });
    } else if (formData && (formData.status === "SENT" || formData.isResend === false)) {
      // Clear replacement flags if formData is marked SENT or replacement is completed
      setSelectedRowRecord(prev => {
        if (prev && isRecordMatch(prev, formData)) {
          return {
            ...prev,
            replacementCode: undefined,
            isResend: false,
            emailType: undefined,
            emailTemplate: undefined,
            status: "SENT",
            isDispatched: true
          };
        }
        return prev;
      });
    }
  }, [formData?.voucherCodesText, formData?.replacementCode, formData?.emailType, formData?.isResend, formData?.emailTemplate, formData?.status, database]);

  // Keep selectedRowRecord up to date with latest database updates
  useEffect(() => {
    if (selectedRowRecord && database) {
      const updated = database.find(r => isRecordMatch(r, selectedRowRecord));
      if (updated) {
        setSelectedRowRecord(prev => {
          if (!prev) return null;
          const isDisp = checkIsRecordDispatched(updated, updated.vrm, updated.driverName, updated.dateRequired, dispatchedKeysSet, unsentKeysSet);
          return {
            ...prev,
            ...updated,
            replacementCode: isDisp ? undefined : (updated.replacementCode !== undefined ? updated.replacementCode : prev.replacementCode),
            isResend: isDisp ? false : (updated.isResend !== undefined ? updated.isResend : prev.isResend),
            emailType: isDisp ? undefined : (updated.emailType !== undefined ? updated.emailType : prev.emailType),
            emailTemplate: isDisp ? undefined : (updated.emailTemplate !== undefined ? updated.emailTemplate : prev.emailTemplate)
          };
        });
      }
    }
  }, [database, dispatchedKeysSet, unsentKeysSet]);

  const handleRowClick = (record: CsvPermitRecord) => {
    setSelectedRowRecord(record);
    onSelectRecord(record);
  };

  // Target ISO for Active Date Codes dropdown
  const targetIso = useMemo(() => {
    if (formData) {
      const permitIso = getRequestedPermitDateISO(formData as any);
      if (permitIso && /^\d{4}-\d{2}-\d{2}$/.test(permitIso)) {
        return permitIso;
      }
      const formDateIso = formData.todayDate ? parseDateToISO(String(formData.todayDate)) : "";
      if (formDateIso && /^\d{4}-\d{2}-\d{2}$/.test(formDateIso)) {
        return formDateIso;
      }
    }
    const procIso = processingDate ? parseDateToISO(processingDate) : "";
    if (procIso && /^\d{4}-\d{2}-\d{2}$/.test(procIso)) {
      return procIso;
    }
    return getTodayISO();
  }, [formData?.validFrom, formData?.dateRequired, formData?.startTime, formData?.createdAt, formData?.todayDate, processingDate]);


  const [blocklistVersion, setBlocklistVersion] = useState<number>(0);
  useEffect(() => {
    const handleBlocklistUpdate = () => {
      setBlocklistVersion(v => v + 1);
    };
    window.addEventListener("blocklist_updated", handleBlocklistUpdate);
    return () => window.removeEventListener("blocklist_updated", handleBlocklistUpdate);
  }, []);

  // Base records
  const baseRecords = useMemo(() => {
    return sortRecordsByFormIdDesc(database);
  }, [database]);

  // ⭐ Pre-compute record cancellation status once per database & processingDate update
  const recordCancellationMap = useMemo(() => {
    const map = new WeakMap<object, boolean>();
    (database || []).forEach(record => {
      if (!record || typeof record !== "object") return;
      if (record.isCancelled === true) {
        map.set(record, true);
        return;
      }
      if (typeof record.status === "string" && record.status.trim().toLowerCase().includes("cancel")) {
        map.set(record, true);
        return;
      }
      if (record.isCancelled === false && String(record.status || "").trim().toUpperCase() === "ACTIVE") {
        // Explicitly active
      } else if (
        record.voucherCode === "CANCELLED" ||
        record.voucherCodesText === "CANCELLED" ||
        record.prePaidCode === "CANCELLED" ||
        (typeof record.voucherCode === "string" && record.voucherCode.trim().toUpperCase() === "CANCELLED") ||
        (typeof record.voucherCodesText === "string" && record.voucherCodesText.trim().toUpperCase() === "CANCELLED") ||
        (typeof record.prePaidCode === "string" && record.prePaidCode.trim().toUpperCase() === "CANCELLED")
      ) {
        map.set(record, true);
        return;
      }
      const reqDate = getRequestedPermitDateISO(record, processingDate);
      const isCancelled = isRecordCancelled(record, reqDate, database);
      map.set(record, isCancelled);
    });
    return map;
  }, [database, processingDate]);

  // ⭐ Pre-compute target local timestamps once per database & processingDate update
  const recordTimestampMap = useMemo(() => {
    const map = new WeakMap<object, number | null>();

    const toLocalTimestamp = (rawValue: unknown): number | null => {
      if (rawValue === undefined || rawValue === null || rawValue === "") return null;
      if (rawValue instanceof Date) {
        const t = rawValue.getTime();
        return !isNaN(t) && t > 0 ? t : null;
      }
      if (typeof rawValue === "number") {
        if (isNaN(rawValue) || rawValue <= 0) return null;
        if (rawValue > 30000 && rawValue < 60000) {
          const ms = (rawValue - 25569) * 86400 * 1000;
          return isNaN(ms) ? null : ms;
        }
        return rawValue;
      }
      const rawStr = String(rawValue).trim();
      if (!rawStr || rawStr === "-" || rawStr === "—" || rawStr.toLowerCase() === "null" || rawStr.toLowerCase() === "undefined") {
        return null;
      }
      const canonicalISO = parseDateToISO(rawStr) || safeParseDMYToISO(rawStr);
      if (canonicalISO && /^\d{4}-\d{2}-\d{2}$/.test(canonicalISO)) {
        const [yStr, mStr, dStr] = canonicalISO.split("-");
        const year = parseInt(yStr, 10);
        const month = parseInt(mStr, 10);
        const day = parseInt(dStr, 10);
        let hours = 0;
        let minutes = 0;
        let seconds = 0;
        const timeMatch = rawStr.match(/(?:[ T]|^)(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (timeMatch) {
          hours = parseInt(timeMatch[1], 10);
          minutes = parseInt(timeMatch[2], 10);
          seconds = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
        }
        if (!isNaN(year) && !isNaN(month) && !isNaN(day) && !isNaN(hours) && !isNaN(minutes) && !isNaN(seconds)) {
          const localDate = new Date(year, month - 1, day, hours, minutes, seconds);
          const localTime = localDate.getTime();
          if (!isNaN(localTime) && localTime > 0) return localTime;
        }
      }
      return safeParseDateToTimestamp(rawStr);
    };

    (database || []).forEach(record => {
      if (!record || typeof record !== "object") return;
      let subTs: number | null = null;
      const rawSubDate = record?.completionTime ?? 
                         (record as any)?.completion_time ?? 
                         record?.startTime ?? 
                         (record as any)?.start_time ?? 
                         record?.createdAt ?? 
                         (record as any)?.created_at;
      if (rawSubDate !== undefined && rawSubDate !== null && rawSubDate !== "") {
        subTs = toLocalTimestamp(rawSubDate);
      }
      if (subTs === null) {
        const subMs = getRecordSubmittedTimeMs(record);
        if (subMs > 0) subTs = subMs;
      }
      let reqTs: number | null = null;
      const rawReqDate = record?.dateRequired ?? 
                         record?.validFrom ?? 
                         record?.todayDate ?? 
                         record?.["Date Required"] ?? 
                         record?.["Valid From"];
      reqTs = toLocalTimestamp(rawReqDate);
      if (reqTs === null) {
        const iso = getRequestedPermitDateISO(record, processingDate);
        if (iso) reqTs = toLocalTimestamp(iso);
      }
      let targetTs = subTs !== null ? subTs : reqTs;
      if (targetTs === null) {
        const recDateISO = 
          getRecordSubmittedDateISO(record) ||
          getRequestedPermitDateISO(record, processingDate) ||
          parseDateToISO(record?.completionTime || record?.startTime || record?.createdAt || (record as any)?.created_at || "") ||
          safeParseDMYToISO(record?.completionTime ?? record?.startTime ?? record?.createdAt ?? (record as any)?.created_at ?? null);
        if (recDateISO) {
          targetTs = toLocalTimestamp(recDateISO);
        }
      }
      map.set(record, targetTs);
    });

    return map;
  }, [database, processingDate]);

  // Compute dynamic voucher allocations map
  const recordCodeMap = useMemo(() => {
    return getSpreadsheetMatchingAllocationsMap(
      baseRecords,
      database,
      processingDate,
      vouchersDatabase,
      customVouchers
    );
  }, [baseRecords, database, processingDate, vouchersDatabase, customVouchers, blocklistVersion]);

  // Assigned voucher codes set across the concessions database, custom allocations, AND recordCodeMap
  const assignedVoucherCodesSet = useMemo(() => {
    const set = new Set<string>();

    // 1. Include allocations from recordCodeMap (canonical allocation source)
    if (recordCodeMap) {
      recordCodeMap.forEach((code) => {
        if (code && typeof code === "string") {
          const clean = cleanVoucherCodeValue(code).toUpperCase();
          if (clean && clean !== "-" && clean !== "CANCELLED" && clean !== "PENDING" && clean !== "BLOCKED") {
            set.add(clean);
          }
        }
      });
    }

    // 2. Include database records and index by ID/formId for O(1) customVouchers lookup
    const dbRecordByIdMap = new Map<string, CsvPermitRecord>();
    (database || []).forEach(rec => {
      if (rec.formId !== undefined && rec.formId !== null) dbRecordByIdMap.set(String(rec.formId), rec);
      if (rec.id !== undefined && rec.id !== null) dbRecordByIdMap.set(String(rec.id), rec);

      // Cancelled or blocked permits MUST NOT consume a voucher - they release their codes back to inventory
      const isBlocked = isVrmSilentBlockedSync(rec.vrm);
      const isCancelled = recordCancellationMap.has(rec)
        ? recordCancellationMap.get(rec)!
        : (rec.isCancelled === true ||
           (typeof rec.status === "string" && rec.status.toLowerCase().includes("cancel")) ||
           rec.voucherCode === "CANCELLED" ||
           rec.prePaidCode === "CANCELLED");
      if (isBlocked || isCancelled) {
        return;
      }

      if (rec.replacementCode && typeof rec.replacementCode === "string") {
        const clean = cleanVoucherCodeValue(rec.replacementCode).toUpperCase();
        if (clean && clean !== "-" && clean !== "CANCELLED" && clean !== "PENDING" && clean !== "N/A" && clean !== "BLOCKED") {
          set.add(clean);
        }
      }

      // IMPORTANT: replacement does not release the original assigned voucher.
      // Keep every live assignment consumed until its record is genuinely cancelled.
      const assignedCodeFields = [
        rec.originalVoucherCode,
        rec.voucherCode,
        rec.prePaidCode
      ];

      assignedCodeFields.forEach((raw) => {
        if (raw === null || raw === undefined || raw === "") return;

        const clean = cleanVoucherCodeValue(String(raw)).toUpperCase();
        if (clean && clean !== "-" && clean !== "CANCELLED" && clean !== "PENDING" && clean !== "N/A" && clean !== "BLOCKED") {
          set.add(clean);
        }
      });
    });

    // Also include active replacement/original codes from formData while replacement is in progress.
    [formData?.originalVoucherCode, formData?.replacementCode].forEach((raw) => {
      if (raw === null || raw === undefined || raw === "") return;

      const clean = cleanVoucherCodeValue(String(raw)).toUpperCase();
      if (clean && clean !== "-" && clean !== "CANCELLED" && clean !== "PENDING" && clean !== "N/A" && clean !== "BLOCKED") {
        set.add(clean);
      }
    });

    // 3. Include customVouchers (using O(1) indexed lookup)
    if (customVouchers) {
      Object.entries(customVouchers).forEach(([key, raw]) => {
        if (raw && typeof raw === "string") {
          const clean = cleanVoucherCodeValue(raw).toUpperCase();
          if (clean && clean !== "-" && clean !== "CANCELLED" && clean !== "PENDING" && clean !== "N/A" && clean !== "BLOCKED") {
            const matchingRec = dbRecordByIdMap.get(key);
            if (matchingRec) {
              const reqDate = getRequestedPermitDateISO(matchingRec, processingDate);
              const isCancelled = recordCancellationMap.has(matchingRec)
                ? recordCancellationMap.get(matchingRec)!
                : isRecordCancelled(matchingRec, reqDate, database);
              if (isVrmSilentBlockedSync(matchingRec.vrm) || isCancelled) {
                return;
              }
            }
            set.add(clean);
          }
        }
      });
    }

    return set;
  }, [database, customVouchers, processingDate, recordCodeMap, formData?.replacementCode, formData?.originalVoucherCode]);

  // Active record is either the explicitly clicked row, or matching record from formData, or the first record in database
  const activeRecord = useMemo<CsvPermitRecord | null>(() => {
    if (selectedRowRecord) {
      const updated = (database || []).find(r => isRecordMatch(r, selectedRowRecord));
      if (updated) {
        const isDisp = checkIsRecordDispatched(updated, updated.vrm, updated.driverName, updated.dateRequired, dispatchedKeysSet, unsentKeysSet);
        return {
          ...updated,
          replacementCode: isDisp ? undefined : (updated.replacementCode !== undefined ? updated.replacementCode : selectedRowRecord.replacementCode),
          isResend: isDisp ? false : (updated.isResend !== undefined ? updated.isResend : selectedRowRecord.isResend),
          emailType: isDisp ? undefined : (updated.emailType !== undefined ? updated.emailType : selectedRowRecord.emailType),
          emailTemplate: isDisp ? undefined : (updated.emailTemplate !== undefined ? updated.emailTemplate : selectedRowRecord.emailTemplate)
        };
      }
      return selectedRowRecord;
    }
    if (formData) {
      const match = (database || []).find(r => isRecordMatch(r, formData));
      if (match) {
        if (formData.emailType === "RESEND_CONCESSION" || formData.isResend || formData.replacementCode) {
          return {
            ...match,
            replacementCode: formData.replacementCode || formData.voucherCodesText || match.replacementCode,
            isResend: true,
            emailType: "RESEND_CONCESSION",
            emailTemplate: "replacement"
          };
        }
        return match;
      }
    }
    return database?.[0] || null;
  }, [selectedRowRecord, formData, database, dispatchedKeysSet, unsentKeysSet]);

  // Current permit exact validFrom and validTo ISO matching for the selected row
  const currentPermitValidFromIso = useMemo(() => {
    if (activeRecord) {
      const from = getRequestedPermitDateISO(activeRecord) || parseDateToISO(activeRecord.validFrom || activeRecord.dateRequired);
      if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) return from;
    }
    if (formData?.validFrom) {
      const iso = parseDateToISO(String(formData.validFrom));
      if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    }
    if (formData?.dateRequired) {
      const iso = getRequestedPermitDateISO(formData);
      if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    }
    if (formData?.todayDate) {
      const iso = parseDateToISO(String(formData.todayDate));
      if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    }
    return getTodayISO();
  }, [activeRecord, formData?.validFrom, formData?.dateRequired, formData?.todayDate]);

  const currentPermitValidToIso = useMemo(() => {
    if (activeRecord) {
      if (activeRecord.validTo) {
        const iso = parseDateToISO(String(activeRecord.validTo));
        if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
      }
      if (activeRecord.dateExpiry) {
        const iso = parseDateToISO(String(activeRecord.dateExpiry));
        if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
      }
      const rawDate = activeRecord.dateRequired || activeRecord.validFrom;
      if (rawDate) {
        const range = parseDateRange(String(rawDate));
        if (range && range.endISO && /^\d{4}-\d{2}-\d{2}$/.test(range.endISO)) {
          return range.endISO;
        }
      }
    }
    if (formData?.validTo) {
      const iso = parseDateToISO(String(formData.validTo));
      if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    }
    if (currentPermitValidFromIso) {
      return addDays(currentPermitValidFromIso, 6);
    }
    return "";
  }, [activeRecord, formData?.validTo, currentPermitValidFromIso]);

  // ⭐ Pre-index vouchersDatabase by voucher code and validity period for O(1) lookups
  const voucherIndex = useMemo(() => {
    const codeMap = new Map<string, ParsedVoucherData[]>();
    const periodMap = new Map<string, ParsedVoucherData[]>();
    const undatedList: ParsedVoucherData[] = [];

    (vouchersDatabase || []).forEach(v => {
      if (!v || !v.code) return;
      const clean = cleanVoucherCodeValue(v.code).toUpperCase();
      if (!clean) return;

      let cList = codeMap.get(clean);
      if (!cList) {
        cList = [];
        codeMap.set(clean, cList);
      }
      cList.push(v);

      if (clean === "-" || clean === "CANCELLED" || clean === "PENDING" || clean === "BLOCKED") return;

      const vFrom = getVoucherValidFromISO(v);
      const vTo = getVoucherValidToISO(v);
      if (vFrom && vTo) {
        const key = `${vFrom}_${vTo}`;
        let pList = periodMap.get(key);
        if (!pList) {
          pList = [];
          periodMap.set(key, pList);
        }
        pList.push(v);
      } else {
        undatedList.push(v);
      }
    });

    const getVouchersForDateRange = (permitFromISO: string, permitToISO?: string): ParsedVoucherData[] => {
      if (!permitFromISO) return [];
      const normFrom = normalizeDateToISO(permitFromISO);
      if (!normFrom) return [];
      const normTo = permitToISO ? normalizeDateToISO(permitToISO) : addDaysISO(normFrom, 6);
      const exact = periodMap.get(`${normFrom}_${normTo}`) || [];
      if (undatedList.length === 0) return exact;
      return [...exact, ...undatedList.filter(v => isVoucherForPermitDateRange(v, normFrom, normTo))];
    };

    return { codeMap, periodMap, undatedList, getVouchersForDateRange };
  }, [vouchersDatabase]);

  // Helper to check if a voucher matches the permit's validity period
  const hasDatedVouchersForDate = useMemo(() => {
    if (!vouchersDatabase || vouchersDatabase.length === 0 || !currentPermitValidFromIso) return false;
    return voucherIndex.getVouchersForDateRange(currentPermitValidFromIso, currentPermitValidToIso).length > 0;
  }, [voucherIndex, vouchersDatabase, currentPermitValidFromIso, currentPermitValidToIso]);

  const isVoucherMatchingPeriod = useCallback((v: ParsedVoucherData | undefined | null): boolean => {
    return isVoucherForPermitDateRange(v, currentPermitValidFromIso, currentPermitValidToIso);
  }, [currentPermitValidFromIso, currentPermitValidToIso]);

  // Unused vouchers computation for the active date using getSelectableActiveDateCodes
  const unusedVouchersForDay = useMemo<ParsedVoucherData[]>(() => {
    if (!currentPermitValidFromIso || !vouchersDatabase || vouchersDatabase.length === 0) {
      return [];
    }
    const validTo = currentPermitValidToIso || currentPermitValidFromIso;
    return getSelectableActiveDateCodes({
      vouchersDatabase,
      database,
      permitDateRequired: currentPermitValidFromIso,
      permitDateExpiry: validTo,
      currentRecord: selectedRowRecord || activeRecord,
      extraExcludedCodes: activeRecord ? [activeRecord.voucherCode, activeRecord.prePaidCode, activeRecord.voucherCodesText, activeRecord.replacementCode] : []
    });
  }, [
    vouchersDatabase,
    database,
    currentPermitValidFromIso,
    currentPermitValidToIso,
    selectedRowRecord,
    activeRecord
  ]);

  // Exact range voucher stock metrics for Active Date Codes dropdown badge
  const totalForThisRange = useMemo(() => {
    if (!currentPermitValidFromIso || !vouchersDatabase || vouchersDatabase.length === 0) {
      return 0;
    }
    const validTo = currentPermitValidToIso || currentPermitValidFromIso;
    return voucherIndex.getVouchersForDateRange(currentPermitValidFromIso, validTo).length;
  }, [voucherIndex, vouchersDatabase, currentPermitValidFromIso, currentPermitValidToIso]);

  const remainingForThisRange = unusedVouchersForDay.length;
  const percentRemaining = totalForThisRange > 0
    ? (remainingForThisRange / totalForThisRange) * 100
    : 0;
  const isRangeStockLow = totalForThisRange === 0 || remainingForThisRange <= 5 || percentRemaining <= 5;


  const handleActiveDateCodeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedCode = cleanVoucherCodeValue(e.target.value).toUpperCase();
    if (!selectedCode || selectedCode === "-" || selectedCode === "CANCELLED") {
      return;
    }

    const currentRec = activeRecord || selectedRowRecord;
    const assignedSet = buildAssignedCodeSet(database, currentRec);

    if (assignedSet.has(selectedCode)) {
      setAssignmentError(`${selectedCode} is no longer available`);
      setTimeout(() => setAssignmentError(null), 4000);
      return;
    }
    setAssignmentError(null);

    setIsReplacingCode(true);

    const originalVoucherCode = currentRec?.originalVoucherCode || currentRec?.voucherCode || currentRec?.prePaidCode;

    if (currentRec) {
      setSelectedRowRecord({
        ...currentRec,
        originalVoucherCode: originalVoucherCode || currentRec.originalVoucherCode,
        replacementCode: selectedCode,
        isResend: true,
        emailType: "RESEND_CONCESSION",
        emailTemplate: "replacement"
      });
    }

    onChangeFormData?.({
      id: currentRec?.id,
      formId: currentRec?.formId,
      vrm: currentRec?.vrm,
      originalVoucherCode: originalVoucherCode || undefined,
      replacementCode: selectedCode,
      voucherCodesText: selectedCode,
      status: "Pending",
      emailType: "RESEND_CONCESSION",
      isResend: true,
      emailTemplate: "replacement"
    });

    setTimeout(() => {
      setIsReplacingCode(false);
    }, 600);
  };

  // Sorting state
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);

  // Dropdown filter states
  const [statusFilter, setStatusFilter] = useState<"ALL" | "PENDING" | "SENT" | "CANCELLED" | "BLOCKED" | "REPLACEMENT">("ALL");
  const [hospitalFilter, setHospitalFilter] = useState<string>("ALL");
  const [wardFilter, setWardFilter] = useState<string>("ALL");
  // ⭐ FIX: Restore default filter to "This Week"
  const [dateFilter, setDateFilter] = useState<"ALL" | "TODAY" | "THIS_WEEK" | "THIS_MONTH" | "CUSTOM">("THIS_WEEK");

  useEffect(() => {
    // Don't let the parent's fetch-range prop clobber a local "Today" or "Custom Range"
    // selection — both legitimately map to onDateRangeFilterChange("all") for data-fetching
    // purposes, but that shouldn't reset the user's actual filter choice back to "ALL".
    if (dateFilter === "TODAY" || dateFilter === "CUSTOM") return;
    if (dateRangeFilter === "7days") setDateFilter("THIS_WEEK");
    else if (dateRangeFilter === "30days") setDateFilter("THIS_MONTH");
    else if (dateRangeFilter === "all") setDateFilter("ALL");
  }, [dateRangeFilter]);
  const [customStartDate, setCustomStartDate] = useState<string>("");
  const [customEndDate, setCustomEndDate] = useState<string>("");

  // Pagination state
  const [pageSize, setPageSize] = useState<number>(50);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [goToPageInput, setGoToPageInput] = useState<string>("");
  const tableContainerRef = useRef<HTMLDivElement>(null);

  const isSameSelectedRecord = useCallback((record: CsvPermitRecord) => {
    if (selectedRowRecord) {
      return isRecordMatch(record, selectedRowRecord);
    }
    if (formData) {
      return isRecordMatch(record, formData);
    }
    return false;
  }, [selectedRowRecord, formData]);

  const isReplacementPending = useCallback((record: CsvPermitRecord) => {
    if (!record) return false;
    const isDisp = checkIsRecordDispatched(record, record.vrm, record.driverName, record.dateRequired, dispatchedKeysSet, unsentKeysSet);
    // If the record has been dispatched and doesn't have an unapplied new replacement code, it is NOT pending
    if (isDisp && !record.replacementCode) {
      return false;
    }
    if (
      Boolean(record.replacementCode) ||
      record.emailType === "RESEND_CONCESSION" ||
      (record.isResend === true && !isDisp) ||
      record.emailTemplate === "replacement"
    ) {
      return true;
    }
    if (selectedRowRecord && isRecordMatch(record, selectedRowRecord)) {
      return (
        Boolean(selectedRowRecord.replacementCode) ||
        selectedRowRecord.emailType === "RESEND_CONCESSION" ||
        (selectedRowRecord.isResend === true && !isDisp) ||
        selectedRowRecord.emailTemplate === "replacement"
      );
    }
    if (
      formData &&
      isRecordMatch(record, formData) &&
      (formData?.emailType === "RESEND_CONCESSION" ||
        (formData?.isResend === true && !isDisp) ||
        formData?.emailTemplate === "replacement" ||
        Boolean(formData?.replacementCode))
    ) {
      return true;
    }
    return false;
  }, [dispatchedKeysSet, unsentKeysSet, selectedRowRecord, formData]);

  const getHospital = useCallback((record: CsvPermitRecord) => {
    const raw = String(record?.hospital ?? "").trim();
    if (raw && !raw.toLowerCase().includes("royal london")) {
      return raw;
    }
    const ward = (record?.ward || "").toLowerCase();
    return (
      ward.includes("acorn") || 
      ward.includes("acacia") || 
      ward.includes("mulberry")
    ) ? "Whipps Cross Hospital" : "Newham Hospital";
  }, []);

  // Selected site/hospital resolution
  const selectedHospital = useMemo(() => {
    if (hospitalFilter && hospitalFilter !== "ALL") {
      return hospitalFilter;
    }
    if (formData?.hospitalSite) {
      return formData.hospitalSite;
    }
    if (formData?.hospital) {
      return formData.hospital;
    }
    if (activeRecord) {
      return getHospital(activeRecord);
    }
    return "";
  }, [hospitalFilter, formData?.hospitalSite, formData?.hospital, activeRecord]);

  // Voucher Inventory Expiry & Warning Badge:
  // 1. Color Threshold Rules:
  //    - Green (> 3 days remaining): "🟢 Codes Valid Until: DD/MM/YYYY (X days left)"
  //    - Amber (1 to 3 days remaining): "⚠️ Voucher Batch Expiring Soon: DD/MM/YYYY (X days left)"
  //    - Red (0 days or batch expired): "🔴 No Active Codes Available — Add New Batch"
  // 2. Strict Date Calculation:
  //    Ensure current date is dynamically generated using new Date() anchored to system's current date (28/09/2026).
  //    const today = new Date(); today.setHours(0, 0, 0, 0);
  //    const targetDate = new Date(activeCode.validFrom); targetDate.setHours(0, 0, 0, 0);
  //    const daysLeft = Math.round((targetDate.getTime() - today.getTime()) / (1000 * 3600 * 24));
  //    With 2 days left (30/09/2026 - 28/09/2026), evaluates to Amber:
  //    "⚠️ Voucher Batch Expiring Soon: 30/09/2026 (2 days left)"
  // 3. Layout Constraint:
  //    Keep "Active Date Codes ({count}):", select dropdown, and badge on a single row (flex flex-row items-center whitespace-nowrap).
  const voucherBatchBadge = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return computeVoucherBatchExpiryBadge({
      vouchersDatabase,
      assignedVoucherCodesSet,
      selectedHospital,
      referenceDate: today
    });
  }, [
    vouchersDatabase,
    assignedVoucherCodesSet,
    selectedHospital
  ]);

  const getIsCancelled = useCallback((record: CsvPermitRecord, idx?: number) => {
    if (!record) return false;
    if (recordCancellationMap.has(record)) {
      return recordCancellationMap.get(record)!;
    }
    if (record.cancellationReason === "MANUAL" || record.cancellationReason === "BLOCKLIST") return true;
    if (record.cancellationReason !== "DUPLICATE_VRM") {
      if (record.isCancelled === true) return true;
      if (typeof record.status === "string" && record.status.trim().toLowerCase().includes("cancel")) return true;
      if (record.isCancelled === false && String(record.status || "").trim().toUpperCase() === "ACTIVE") {
        // Explicitly active record: do not let stale CANCELLED string in voucherCode override active status
      } else if (
        record.voucherCode === "CANCELLED" ||
        record.voucherCodesText === "CANCELLED" ||
        record.prePaidCode === "CANCELLED" ||
        (typeof record.voucherCode === "string" && record.voucherCode.trim().toUpperCase() === "CANCELLED") ||
        (typeof record.voucherCodesText === "string" && record.voucherCodesText.trim().toUpperCase() === "CANCELLED") ||
        (typeof record.prePaidCode === "string" && record.prePaidCode.trim().toUpperCase() === "CANCELLED")
      ) {
        return true;
      }
    }
    const reqDate = getRequestedPermitDateISO(record, processingDate);
    return isRecordCancelled(record, reqDate, database);
  }, [recordCancellationMap, processingDate, database]);

  const getStatusStr = useCallback((record: CsvPermitRecord, idx?: number) => {
    if (!record) return "PENDING";
    if (isVrmSilentBlockedSync(record.vrm)) return "BLOCKED";
    if (getIsCancelled(record, idx)) return "CANCELLED";
    const isDispatched = checkIsRecordDispatched(record, record.vrm, record.driverName, record.dateRequired, dispatchedKeysSet, unsentKeysSet);
    if (isDispatched) return "SENT";
    if (isReplacementPending(record)) return "REPLACEMENT";
    return "PENDING";
  }, [getIsCancelled, dispatchedKeysSet, unsentKeysSet, isReplacementPending]);

  // Dynamic stock cache keyed by date range, automatically invalidated when assigned codes or vouchers change
  const rowVoucherStatsCache = useMemo(() => {
    return new Map<string, { total: number; remaining: number }>();
  }, [vouchersDatabase, assignedVoucherCodesSet]);

  const getRowVoucherStats = useCallback((permitFromISO: string, permitToISO: string, recordVrm?: string) => {
    if (!permitFromISO || !vouchersDatabase || vouchersDatabase.length === 0) {
      return { total: 0, remaining: 0 };
    }
    const validTo = permitToISO || (permitFromISO ? addDays(permitFromISO, 6) : permitFromISO);
    const recordVrmClean = (recordVrm || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const cacheKey = `${permitFromISO}_${validTo}_${recordVrmClean}`;
    const cached = rowVoucherStatsCache.get(cacheKey);
    if (cached) return cached;

    const rangeVouchers = voucherIndex.getVouchersForDateRange(permitFromISO, validTo);
    const matchingRangeVouchers = recordVrmClean
      ? rangeVouchers.filter(v => {
          const vVrmClean = (v.vrm || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
          return !vVrmClean || vVrmClean === recordVrmClean;
        })
      : rangeVouchers;

    const total = matchingRangeVouchers.length;
    let remaining = 0;
    matchingRangeVouchers.forEach(v => {
      if (v.isUsed === true || v.status === "used" || v.status === "dispatched") return;
      const codeUpper = cleanVoucherCodeValue(v.code).toUpperCase();
      if (!codeUpper || codeUpper === "-" || codeUpper === "CANCELLED" || codeUpper === "PENDING") return;
      if (!assignedVoucherCodesSet.has(codeUpper)) {
        remaining++;
      }
    });

    const result = { total, remaining };
    rowVoucherStatsCache.set(cacheKey, result);
    return result;
  }, [rowVoucherStatsCache, voucherIndex, vouchersDatabase, assignedVoucherCodesSet]);

  const todayISO = useMemo(() => getTodayISO(), []);

  // Standardized local-time date boundaries (prevents UTC timezone offsets from shifting today)
  const localDateBounds = useMemo(() => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const currentDate = now.getDate();

    // Start-of-day (00:00:00.000) and End-of-day (23:59:59.999) using local Date construction
    const todayStartDate = new Date(currentYear, currentMonth, currentDate, 0, 0, 0, 0);
    const todayEndDate = new Date(currentYear, currentMonth, currentDate, 23, 59, 59, 999);

    // This Week: 6 days prior (00:00:00) through end of today (23:59:59.999)
    const thisWeekStartDate = new Date(currentYear, currentMonth, currentDate - 6, 0, 0, 0, 0);
    const thisWeekEndDate = new Date(currentYear, currentMonth, currentDate, 23, 59, 59, 999);

    // This Month: 29 days prior (00:00:00) through end of today (23:59:59.999)
    const thisMonthStartDate = new Date(currentYear, currentMonth, currentDate - 29, 0, 0, 0, 0);
    const thisMonthEndDate = new Date(currentYear, currentMonth, currentDate, 23, 59, 59, 999);

    // Custom date range bounds in local time
    let customStartDateObj: Date | null = null;
    if (customStartDate) {
      const parsedStart = safeParseDateToTimestamp(customStartDate);
      if (parsedStart !== null) {
        const d = new Date(parsedStart);
        customStartDateObj = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
      }
    }

    let customEndDateObj: Date | null = null;
    if (customEndDate) {
      const parsedEnd = safeParseDateToTimestamp(customEndDate);
      if (parsedEnd !== null) {
        const d = new Date(parsedEnd);
        customEndDateObj = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
      }
    }

    return {
      todayStartDate,
      todayEndDate,
      startOfToday: todayStartDate.getTime(),
      endOfToday: todayEndDate.getTime(),

      thisWeekStartDate,
      thisWeekEndDate,
      startOfThisWeek: thisWeekStartDate.getTime(),
      endOfThisWeek: thisWeekEndDate.getTime(),

      thisMonthStartDate,
      thisMonthEndDate,
      startOfThisMonth: thisMonthStartDate.getTime(),
      endOfThisMonth: thisMonthEndDate.getTime(),

      customStartDateObj,
      customEndDateObj,
      customStartMs: customStartDateObj ? customStartDateObj.getTime() : null,
      customEndMs: customEndDateObj ? customEndDateObj.getTime() : null
    };
  }, [customStartDate, customEndDate]);

  const allHospitalsList = useMemo(() => {
    const standardHospitals = ["Newham Hospital", "Whipps Cross Hospital"];
    const set = new Set<string>(standardHospitals);
    database.forEach(r => {
      const h = (r?.hospital || "").trim();
      if (h && !h.toLowerCase().includes("royal london")) {
        set.add(h);
      }
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [database]);

  const allWardsList = useMemo(() => {
    const standardWards = [
      "Maternity",
      "Labour Ward",
      "Mulberry",
      "Acorn",
      "Acacia",
      "ICU",
      "Antenatal",
      "Postnatal"
    ];
    const set = new Set<string>(standardWards);
    database.forEach(r => {
      const w = (r?.ward || "").trim();
      if (w) set.add(w);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [database]);

  // Repeat User Submissions Index: O(N) build on database changes, O(1) row lookup.
  // Email is the canonical identity; normalized name is used only when email is unavailable.
  const { userSubmissionsMap, recordToUserMap } = useMemo(() => {
    type UserSubmissionEntry = {
      identifier: string;
      displayName: string;
      email: string;
      count: number;
      firstSubmissionMs: number;
      latestSubmissionMs: number;
    };

    const userSubmissionsMap = new Map<string, UserSubmissionEntry>();
    const recordToUserMap = new Map<string, string>();

    const cleanEmail = (value?: string) => {
      const normalized = (value || "").trim().toLowerCase();
      return !normalized || normalized === "-" || normalized === "null" || normalized === "undefined"
        ? ""
        : normalized;
    };

    const cleanName = (value?: string) => {
      const normalized = (value || "").trim().toLowerCase().replace(/\s+/g, " ");
      return !normalized || normalized === "-" || normalized === "null" || normalized === "undefined" || normalized === "unknown"
        ? ""
        : normalized;
    };

    database.forEach((record, index) => {
      if (!record) return;

      const email = cleanEmail(record.email || record.driverEmail);
      const normalizedName = cleanName(record.driverName || record.name);
      if (!email && !normalizedName) return;

      const identifier = email ? `email:${email}` : `name:${normalizedName}`;
      const displayNameRaw = (record.driverName || record.name || "").trim();
      const submittedMs = getRecordSubmittedTimeMs(record);
      const recordKey = String(record.formId ?? record.id ?? `${record.vrm}_${record.dateRequired}_${index}`);

      const existing = userSubmissionsMap.get(identifier);
      if (existing) {
        existing.count += 1;
        if (!existing.displayName && displayNameRaw) existing.displayName = toTitleCase(displayNameRaw);
        if (submittedMs > 0) {
          if (existing.firstSubmissionMs === 0 || submittedMs < existing.firstSubmissionMs) existing.firstSubmissionMs = submittedMs;
          if (submittedMs > existing.latestSubmissionMs) existing.latestSubmissionMs = submittedMs;
        }
      } else {
        userSubmissionsMap.set(identifier, {
          identifier,
          displayName: displayNameRaw ? toTitleCase(displayNameRaw) : email,
          email,
          count: 1,
          firstSubmissionMs: submittedMs > 0 ? submittedMs : 0,
          latestSubmissionMs: submittedMs > 0 ? submittedMs : 0
        });
      }

      recordToUserMap.set(recordKey, identifier);
    });

    return { userSubmissionsMap, recordToUserMap };
  }, [database]);

  const [activeUserPopoverKey, setActiveUserPopoverKey] = useState<string | null>(null);
  const [popoverAnchorRect, setPopoverAnchorRect] = useState<DOMRect | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setActiveUserPopoverKey(null);
        setPopoverAnchorRect(null);
      }
    }
    if (activeUserPopoverKey) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [activeUserPopoverKey]);

  useEffect(() => {
    setCurrentPage(1);
  }, [
    searchQuery,
    statusFilter,
    hospitalFilter,
    wardFilter,
    dateFilter,
    customStartDate,
    customEndDate,
    pageSize
  ]);

  // Stable key for replacement status in formData to avoid refiltering on unrelated form edits
  const formDataReplacementKey = `${formData?.id || formData?.formId || formData?.vrm || ''}_${formData?.replacementCode || ''}_${formData?.emailType || ''}_${formData?.isResend || ''}_${formData?.emailTemplate || ''}`;

  // ⭐ STEP 1: Filter first in O(N) linear scan
  const filteredRecords = useMemo(() => {
    const cleanSearchQuery = (searchQuery && searchQuery.trim()) ? searchQuery.trim().toLowerCase() : "";
    const cleanHospitalFilter = hospitalFilter !== "ALL" ? hospitalFilter.toLowerCase().trim() : "";
    const cleanWardFilter = wardFilter !== "ALL" ? wardFilter.toLowerCase() : "";

    let dateRangeStart = 0;
    let dateRangeEnd = 0;
    let isDateFiltering = dateFilter !== "ALL";

    if (isDateFiltering) {
      if (dateFilter === "TODAY") {
        dateRangeStart = localDateBounds.todayStartDate.getTime();
        dateRangeEnd = localDateBounds.todayEndDate.getTime();
      } else if (dateFilter === "THIS_WEEK") {
        dateRangeStart = localDateBounds.thisWeekStartDate.getTime();
        dateRangeEnd = localDateBounds.thisWeekEndDate.getTime();
      } else if (dateFilter === "THIS_MONTH") {
        dateRangeStart = localDateBounds.thisMonthStartDate.getTime();
        dateRangeEnd = localDateBounds.thisMonthEndDate.getTime();
      } else if (dateFilter === "CUSTOM") {
        if (localDateBounds.customStartDateObj === null && localDateBounds.customEndDateObj === null) {
          isDateFiltering = false;
        } else {
          dateRangeStart = localDateBounds.customStartDateObj ? localDateBounds.customStartDateObj.getTime() : 0;
          dateRangeEnd = localDateBounds.customEndDateObj ? localDateBounds.customEndDateObj.getTime() : Number.MAX_SAFE_INTEGER;
        }
      }
    }

    return baseRecords.filter((record, idx) => {
      if (!record) return false;

      if (cleanSearchQuery) {
        const cleanFormId = String(record?.formId ?? record?.id ?? "");
        const matchesSearch = (
          cleanFormId.toLowerCase().includes(cleanSearchQuery) ||
          (record?.driverName || "").toLowerCase().includes(cleanSearchQuery) ||
          (record?.vrm || "").toLowerCase().includes(cleanSearchQuery) ||
          (record?.hospital || "").toLowerCase().includes(cleanSearchQuery) ||
          (record?.ward || "").toLowerCase().includes(cleanSearchQuery) ||
          (record?.email || "").toLowerCase().includes(cleanSearchQuery) ||
          (record?.voucherCode || "").toLowerCase().includes(cleanSearchQuery)
        );
        if (!matchesSearch) return false;
      }

      if (statusFilter !== "ALL") {
        const status = getStatusStr(record, idx);
        if (statusFilter === "PENDING" && status !== "PENDING") return false;
        if (statusFilter === "SENT" && status !== "SENT") return false;
        if (statusFilter === "CANCELLED" && status.toUpperCase() !== "CANCELLED") return false;
        if (statusFilter === "BLOCKED" && status !== "BLOCKED") return false;
        if (statusFilter === "REPLACEMENT" && status !== "REPLACEMENT") return false;
      }

      if (cleanHospitalFilter) {
        const hosp = getHospital(record);
        if (hosp.toLowerCase().trim() !== cleanHospitalFilter) {
          return false;
        }
      }

      if (cleanWardFilter) {
        const w = (record?.ward || "").toLowerCase();
        if (!w.includes(cleanWardFilter) && w !== cleanWardFilter) {
          return false;
        }
      }

      if (isDateFiltering) {
        const targetTs = recordTimestampMap.has(record) ? recordTimestampMap.get(record)! : null;
        if (targetTs === null || isNaN(targetTs)) {
          return false;
        }
        if (targetTs < dateRangeStart || targetTs > dateRangeEnd) {
          return false;
        }
      }

      return true;
    });
  }, [
    baseRecords,
    searchQuery,
    statusFilter,
    hospitalFilter,
    wardFilter,
    dateFilter,
    localDateBounds,
    recordCancellationMap,
    recordTimestampMap,
    dispatchedKeysSet,
    unsentKeysSet,
    formDataReplacementKey
  ]);

  // ⭐ STEP 2: Sort filtered records using pre-decorated keys in O(M log M) without indexOf
  const sortedRecords = useMemo(() => {
    if (!sortKey || !sortDirection) {
      return filteredRecords;
    }

    const decorated = filteredRecords.map((r, i) => {
      let keyVal: string | number = 0;
      if (!r) {
        return { r, keyVal: 0, numId: i + 1, submittedTime: 0 };
      }

      switch (sortKey) {
        case "id":
          keyVal = getNumericFormId(r) || (i + 1);
          break;
        case "submitted":
        case "qr":
          keyVal = getRecordSubmittedTimeMs(r) || 0;
          break;
        case "driverName":
          keyVal = (r?.driverName || "").trim().toLowerCase();
          break;
        case "vrm":
          keyVal = (r?.vrm || "").trim().toUpperCase();
          break;
        case "voucherCode": {
          const isBlk = isVrmSilentBlockedSync(r?.vrm);
          const isCanc = getIsCancelled(r, i);
          keyVal = isBlk ? "BLOCKED" : (isCanc ? "CANCELLED" : (recordCodeMap.get(String(r?.formId ?? r?.id ?? i)) || r?.voucherCode || ""));
          break;
        }
        case "validFrom":
          keyVal = parseDateToISO(r?.dateRequired || r?.validFrom) || "";
          break;
        case "validTo": {
          const iso = parseDateToISO(r?.dateRequired || r?.validFrom);
          keyVal = r?.validTo ? (parseDateToISO(r.validTo) || "") : (iso ? addDays(iso, 6) : "");
          break;
        }
        case "ward":
          keyVal = (r?.ward || "").trim().toLowerCase();
          break;
        case "hospital":
          keyVal = getHospital(r).toLowerCase();
          break;
        case "status":
          keyVal = getStatusStr(r, i);
          break;
        case "actions": {
          const isCanc = getIsCancelled(r, i);
          const isDisp = checkIsRecordDispatched(r, r?.vrm, r?.driverName, r?.dateRequired, dispatchedKeysSet, unsentKeysSet);
          keyVal = isCanc ? "Unsend" : (isReplacementPending(r) ? "Resend" : (isDisp ? "Unsend" : "Send"));
          break;
        }
        default:
          keyVal = 0;
      }
      return {
        r,
        keyVal,
        numId: getNumericFormId(r) || (i + 1),
        submittedTime: getRecordSubmittedTimeMs(r) || 0
      };
    });

    decorated.sort((a, b) => {
      let comp = 0;
      if (typeof a.keyVal === "string" && typeof b.keyVal === "string") {
        comp = a.keyVal.localeCompare(b.keyVal, undefined, { sensitivity: "base", numeric: true });
      } else if (typeof a.keyVal === "number" && typeof b.keyVal === "number") {
        comp = (Number.isFinite(a.keyVal) ? a.keyVal : 0) - (Number.isFinite(b.keyVal) ? b.keyVal : 0);
      }
      if (comp === 0) {
        const numA = Number.isFinite(a.numId) ? a.numId : 0;
        const numB = Number.isFinite(b.numId) ? b.numId : 0;
        const subA = Number.isFinite(a.submittedTime) ? a.submittedTime : 0;
        const subB = Number.isFinite(b.submittedTime) ? b.submittedTime : 0;
        comp = (numA - numB) || (subA - subB);
      }
      return sortDirection === "asc" ? comp : -comp;
    });

    return decorated.map(d => d.r);
  }, [
    filteredRecords,
    sortKey,
    sortDirection,
    database,
    processingDate,
    recordCodeMap,
    dispatchedKeysSet,
    unsentKeysSet,
    formDataReplacementKey
  ]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      if (sortDirection === "desc") {
        setSortDirection("asc");
      } else if (sortDirection === "asc") {
        setSortKey(null);
        setSortDirection(null);
      } else {
        setSortDirection("desc");
      }
    } else {
      setSortKey(key);
      setSortDirection(key === "id" ? "desc" : "asc");
    }
  };

  const renderSortIndicator = (key: SortKey) => {
    if (sortKey === key) {
      return (
        <span className="inline-flex items-center ml-1 text-[#38bdf8] font-bold text-[11px] animate-pulse">
          {sortDirection === "asc" ? "▲" : "▼"}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center ml-1 text-slate-500/40 group-hover:text-slate-300 text-[9px] transition-colors">
        ▲▼
      </span>
    );
  };

  const activeFilters = useMemo(() => {
    const chips: { id: string; label: string; onRemove: () => void }[] = [];

    if (searchQuery && searchQuery.trim()) {
      chips.push({
        id: "search",
        label: `Search: "${searchQuery.trim()}"`,
        onRemove: () => handleSearchChange("")
      });
    }

    if (statusFilter !== "ALL") {
      chips.push({
        id: "status",
        label: `Status: ${statusFilter}`,
        onRemove: () => setStatusFilter("ALL")
      });
    }

    if (hospitalFilter !== "ALL") {
      chips.push({
        id: "hospital",
        label: `Hospital: ${hospitalFilter}`,
        onRemove: () => setHospitalFilter("ALL")
      });
    }

    if (wardFilter !== "ALL") {
      chips.push({
        id: "ward",
        label: `Ward: ${wardFilter}`,
        onRemove: () => setWardFilter("ALL")
      });
    }

    if (dateFilter !== "ALL") {
      let dateLabel = "Date";
      if (dateFilter === "TODAY") dateLabel = `Date: Today (${formatDate(todayISO)})`;
      else if (dateFilter === "THIS_WEEK") dateLabel = "Date: This Week (Last 7 Days)";
      else if (dateFilter === "THIS_MONTH") dateLabel = "Date: This Month (Last 30 Days)";
      else if (dateFilter === "CUSTOM") {
        dateLabel = `Date: ${customStartDate ? formatDate(customStartDate) : "Start"} → ${customEndDate ? formatDate(customEndDate) : "End"}`;
      }
      chips.push({
        id: "date",
        label: dateLabel,
        onRemove: () => {
          setDateFilter("ALL");
          setCustomStartDate("");
          setCustomEndDate("");
        }
      });
    }

    return chips;
  }, [searchQuery, statusFilter, hospitalFilter, wardFilter, dateFilter, customStartDate, customEndDate, todayISO]);

  const handleClearAllFilters = () => {
    handleSearchChange("");
    setStatusFilter("ALL");
    setHospitalFilter("ALL");
    setWardFilter("ALL");
    setDateFilter("ALL");
    setCustomStartDate("");
    setCustomEndDate("");
    setCurrentPage(1);
  };

  const totalFilteredCount = sortedRecords.length;
  const totalOriginalCount = totalRecordsCount && totalRecordsCount > 0 ? totalRecordsCount : (database.length || 0);
  const isFiltered = activeFilters.length > 0 || totalFilteredCount !== totalOriginalCount;

  const effectivePageSize = pageSize === 0 ? (totalFilteredCount || 50) : pageSize;
  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(totalFilteredCount / effectivePageSize));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);

  const startIndex = totalFilteredCount === 0 ? 0 : (safePage - 1) * effectivePageSize;
  const endIndex = Math.min(startIndex + effectivePageSize, totalFilteredCount);

  // Lightweight zero-dependency row virtualization when "ALL" (pageSize === 0) is selected
  const isAllMode = pageSize === 0;
  const virtualizer = useTableVirtualizer({
    totalCount: sortedRecords.length,
    estimateRowHeight: 48,
    overscan: 20,
    containerRef: tableContainerRef,
    enabled: isAllMode && sortedRecords.length > 50
  });

  const paginatedRecords = useMemo(() => {
    if (virtualizer.isVirtual) {
      return sortedRecords.slice(virtualizer.startIndex, virtualizer.endIndex);
    }
    if (pageSize === 0) {
      return sortedRecords;
    }
    return sortedRecords.slice(startIndex, endIndex);
  }, [virtualizer.isVirtual, virtualizer.startIndex, virtualizer.endIndex, sortedRecords, pageSize, startIndex, endIndex]);

  const pageNumbers = useMemo(() => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const pages: (number | string)[] = [];
    if (safePage <= 4) {
      for (let i = 1; i <= 5; i++) pages.push(i);
      pages.push("...");
      pages.push(totalPages);
    } else if (safePage >= totalPages - 3) {
      pages.push(1);
      pages.push("...");
      for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      pages.push("...");
      pages.push(safePage - 1);
      pages.push(safePage);
      pages.push(safePage + 1);
      pages.push("...");
      pages.push(totalPages);
    }
    return pages;
  }, [totalPages, safePage]);

  const count = filteredRecords.length;
  const totalDbCount = totalRecordsCount && totalRecordsCount > 0 ? totalRecordsCount : database.length;
  const totalVouchersCount = vouchersDatabase.length;
  const unusedVouchersCount = unusedVouchersForDay.length;
  const remainingVoucherPercent = totalVouchersCount > 0 
    ? (unusedVouchersCount / totalVouchersCount) * 100 
    : 0;
  const isVoucherStockLow = remainingVoucherPercent <= 5;

  const validFromDisplay = formData?.validFrom || processingDate || "07/07/2026";
  const validToDisplay = formData?.validTo || (processingDate ? addDays(processingDate, 6) : "13/07/2026");
  const selectedWard = formData?.ward || "Acorn Ward";

  const availableWards = allWardsList;

  const handleAction = async (record: CsvPermitRecord, sent: boolean, replacement = false) => {
    const key = String(record.formId ?? record.id ?? record.vrm);
    setBusyKey(key);
    try {
      if (replacement) {
        if (onResendRecord) {
          await onResendRecord(record);
        } else {
          await onSendRecord?.(record);
        }
        setSelectedRowRecord(prev => {
          if (!prev || !isRecordMatch(prev, record)) return prev;
          return {
            ...prev,
            replacementCode: undefined,
            isResend: false,
            emailType: undefined,
            emailTemplate: undefined,
            status: "SENT",
            isDispatched: true
          };
        });
      }
      else if (sent) await onUnsendRecord?.(record);
      else await onSendRecord?.(record);
    } finally {
      setBusyKey(null);
    }
  };

  const handleExportZip = () => {
    try {
      exportToExcel(filteredRecords, "Concessions_Permits_Export.xlsx", customVouchers, processingDate);
    } catch (e) {
      console.error("Export failed:", e);
    }
  };

  const handleGoToPage = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const pageNum = parseInt(goToPageInput, 10);
    if (!isNaN(pageNum)) {
      const clamped = Math.min(Math.max(1, pageNum), totalPages);
      setCurrentPage(clamped);
      setGoToPageInput("");
    }
  };

  return (
    <section className="w-full bg-white dark:bg-[#030C1B] border border-slate-200 dark:border-[#0D223C] rounded-2xl p-4 md:p-6 shadow-2xl text-slate-700 dark:text-slate-200 transition-colors">
      {/* Top Header Section */}
      <div className="flex flex-col gap-3 pb-4 border-b border-slate-200 dark:border-[#0D223C]">
        <div className="flex items-center justify-between gap-3 w-full flex-nowrap overflow-x-auto pb-0.5">
          {/* Left: Logo & Title */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="w-8 h-8 rounded-full bg-[#1877F2] flex items-center justify-center shadow-md shadow-blue-500/20 text-white shrink-0">
              <Navigation className="w-4 h-4 fill-white text-white" />
            </div>
            <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white tracking-tight whitespace-nowrap shrink-0">
              Permit Dispatch Centre
            </h2>
          </div>

          {/* Center: Browse Buttons & Counts */}
          <div className="flex items-center gap-2.5 shrink-0 flex-nowrap">
            <button
              type="button"
              onClick={onBrowseConcessions}
              className="flex items-center gap-2 bg-[#1A73E8] hover:bg-[#1557b0] text-white rounded-lg h-8 px-3 text-xs font-semibold transition-colors whitespace-nowrap shadow-sm"
            >
              <FileSpreadsheet className="w-4 h-4 shrink-0" />
              <span className="whitespace-nowrap">Browse concessions</span>
            </button>
            <span className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-normal whitespace-nowrap">
              {totalDbCount} concessions
            </span>

            <button
              type="button"
              onClick={onBrowseVouchers}
              className="flex items-center gap-2 bg-[#1A73E8] hover:bg-[#1557b0] text-white rounded-lg h-8 px-3 text-xs font-semibold transition-colors whitespace-nowrap shadow-sm"
            >
              <FileText className="w-4 h-4 shrink-0" />
              <span className="whitespace-nowrap">Browse vouchers</span>
            </button>
            <span className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-normal whitespace-nowrap">
              {totalVouchersCount} vouchers
            </span>
          </div>

          {/* Right: Active Date Codes & Validity Badge on a single line */}
          <div className="flex flex-col gap-1 items-end sm:items-start whitespace-nowrap shrink-0 ml-auto lg:ml-0">
            <div className="flex flex-row items-center gap-2">
              <label 
                className={`text-xs sm:text-sm font-medium whitespace-nowrap shrink-0 ${
                  isRangeStockLow ? "text-[#b91c1c]" : "text-[#15803d]"
                }`}
              >
                Active Date Codes ({unusedVouchersForDay.length}):
              </label>
              <select
                value=""
                onChange={handleActiveDateCodeChange}
                disabled={unusedVouchersForDay.length === 0 || isReplacingCode}
                className={`h-8 px-2.5 py-1 border rounded-lg text-xs font-mono font-bold focus:outline-none transition shrink-0 ${
                  isRangeStockLow
                    ? "bg-[#fee2e2] text-[#b91c1c] border-[#dc2626] cursor-pointer"
                    : "bg-[#dcfce7] text-[#15803d] border-[#16a34a] cursor-pointer"
                }`}
              >
                <option value="" disabled className="font-mono font-normal text-slate-700 bg-white">
                  {vouchersDatabase.length === 0
                    ? "-- No Vouchers Uploaded --"
                    : unusedVouchersForDay.length === 0
                      ? "-- 0 Available --"
                      : isReplacingCode
                        ? "Replacing..."
                        : "-- Choose Code --"}
                </option>
                {unusedVouchersForDay.map((v, index) => {
                  const cleanCode = cleanVoucherCodeValue(v.code).toUpperCase();
                  return (
                    <option
                      key={`voucher_${cleanCode}_${index}`}
                      value={cleanCode}
                      className="font-mono text-gray-900 bg-white"
                    >
                      {cleanCode}
                    </option>
                  );
                })}
              </select>
              {voucherBatchBadge && (
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap shrink-0 shadow-sm ${voucherBatchBadge.className}`}>
                  <span className="text-[11px] leading-none select-none">{voucherBatchBadge.icon}</span>{' '}
                  <span>{voucherBatchBadge.text}</span>
                </span>
              )}
            </div>
            {assignmentError && (
              <div className="text-xs text-rose-600 dark:text-rose-400 font-medium">
                {assignmentError}
              </div>
            )}
          </div>
        </div>

        {/* Second Row: Search & Filters */}
        <div className="flex flex-col gap-2.5 pt-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative flex-1 min-w-[220px]">
              <div className="flex items-center w-full bg-white dark:bg-[#020B19] border border-slate-300 dark:border-[#132A4A] focus-within:border-[#1A73E8] focus-within:ring-2 focus-within:ring-[#1A73E8]/20 rounded-xl px-3.5 py-2 transition shadow-inner">
                <Search className="w-4 h-4 text-sky-500 dark:text-sky-400 shrink-0 mr-2" />
                <input
                  type="text"
                  value={localSearchInput}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder="Search driver, VRN, hospital, voucher..."
                  className="w-full bg-transparent text-xs sm:text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none font-normal"
                />
                {localSearchInput && (
                  <button
                    type="button"
                    onClick={() => handleSearchChange("")}
                    className="text-slate-400 hover:text-slate-900 dark:hover:text-white p-0.5 rounded transition cursor-pointer"
                    title="Clear search"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            <div className="relative shrink-0">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as any)}
                className="h-9.5 pl-3.5 pr-8 bg-white dark:bg-[#020B19] border border-slate-300 dark:border-[#132A4A] text-slate-900 dark:text-white rounded-xl text-xs font-medium focus:outline-none focus:border-[#1A73E8] transition appearance-none cursor-pointer"
              >
                <option value="ALL" className="bg-white dark:bg-[#020B19] text-slate-900 dark:text-white">Status: All</option>
                <option value="PENDING" className="bg-white dark:bg-[#020B19] text-slate-900 dark:text-white">PENDING</option>
                <option value="SENT" className="bg-white dark:bg-[#020B19] text-slate-900 dark:text-white">SENT</option>
                <option value="CANCELLED" className="bg-white dark:bg-[#020B19] text-slate-900 dark:text-white">CANCELLED</option>
                <option value="BLOCKED" className="bg-white dark:bg-[#020B19] text-slate-900 dark:text-white">BLOCKED</option>
                <option value="REPLACEMENT" className="bg-white dark:bg-[#020B19] text-slate-900 dark:text-white">REPLACEMENT</option>
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" />
            </div>

            <div className="relative shrink-0">
              <select
                value={hospitalFilter}
                onChange={(e) => setHospitalFilter(e.target.value)}
                className="h-9.5 pl-3.5 pr-8 bg-white dark:bg-[#020B19] border border-slate-300 dark:border-[#132A4A] text-slate-900 dark:text-white rounded-xl text-xs font-medium focus:outline-none focus:border-[#1A73E8] transition appearance-none cursor-pointer truncate max-w-[200px]"
              >
                <option value="ALL" className="bg-white dark:bg-[#020B19] text-slate-900 dark:text-white">Hospital: All</option>
                {allHospitalsList.map(h => (
                  <option key={h} value={h} className="bg-white dark:bg-[#020B19] text-slate-900 dark:text-white">{h}</option>
                ))}
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" />
            </div>

            <div className="relative shrink-0">
              <select
                value={wardFilter}
                onChange={(e) => setWardFilter(e.target.value)}
                className="h-9.5 pl-3.5 pr-8 bg-white dark:bg-[#020B19] border border-slate-300 dark:border-[#132A4A] text-slate-900 dark:text-white rounded-xl text-xs font-medium focus:outline-none focus:border-[#1A73E8] transition appearance-none cursor-pointer truncate max-w-[200px]"
              >
                <option value="ALL" className="bg-white dark:bg-[#020B19] text-slate-900 dark:text-white">Ward: All</option>
                {allWardsList.map(w => (
                  <option key={w} value={w} className="bg-white dark:bg-[#020B19] text-slate-900 dark:text-white">{w}</option>
                ))}
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" />
            </div>

            <div className="relative shrink-0">
              <select
                id="date-filter-dropdown"
                value={dateFilter}
                onChange={(e) => {
                  const next = e.target.value as "ALL" | "TODAY" | "THIS_WEEK" | "THIS_MONTH" | "CUSTOM";
                  setDateFilter(next);
                  if (next === "THIS_WEEK") {
                    onDateRangeFilterChange?.("7days");
                  } else if (next === "THIS_MONTH") {
                    onDateRangeFilterChange?.("30days");
                  } else {
                    onDateRangeFilterChange?.("all");
                  }
                  if (next === "ALL") {
                    setCustomStartDate("");
                    setCustomEndDate("");
                  }
                }}
                className="h-9.5 pl-3.5 pr-8 bg-white dark:bg-[#020B19] border border-slate-300 dark:border-[#132A4A] text-slate-900 dark:text-white rounded-xl text-xs font-medium focus:outline-none focus:border-[#1A73E8] transition appearance-none cursor-pointer"
              >
                <option value="ALL" className="bg-white dark:bg-[#020B19] text-slate-900 dark:text-white">{isLoadingHistory ? "Loading..." : "Date: All Time"}</option>
                <option value="TODAY" className="bg-white dark:bg-[#020B19] text-slate-900 dark:text-white">Today</option>
                <option value="THIS_WEEK" className="bg-white dark:bg-[#020B19] text-slate-900 dark:text-white">This Week</option>
                <option value="THIS_MONTH" className="bg-white dark:bg-[#020B19] text-slate-900 dark:text-white">This Month</option>
                <option value="CUSTOM" className="bg-white dark:bg-[#020B19] text-slate-900 dark:text-white">Custom Range</option>
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" />
            </div>
          </div>

          {dateFilter === "CUSTOM" && (
            <div className="flex flex-wrap items-center gap-3 p-2.5 bg-blue-50/70 dark:bg-[#0b2138] border border-blue-200 dark:border-[#183d63] rounded-xl text-xs animate-in fade-in">
              <div className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-300">
                <Calendar className="w-3.5 h-3.5 text-blue-600 dark:text-[#38bdf8]" />
                <span>Custom Date Range:</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">From:</label>
                <input
                  type="date"
                  value={customStartDate}
                  onChange={(e) => setCustomStartDate(e.target.value)}
                  className="px-2.5 py-1 bg-white dark:bg-[#041222] border border-slate-300 dark:border-[#1b436c] rounded-lg text-slate-900 dark:text-white font-mono text-xs focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">To:</label>
                <input
                  type="date"
                  value={customEndDate}
                  onChange={(e) => setCustomEndDate(e.target.value)}
                  className="px-2.5 py-1 bg-white dark:bg-[#041222] border border-slate-300 dark:border-[#1b436c] rounded-lg text-slate-900 dark:text-white font-mono text-xs focus:outline-none focus:border-blue-500"
                />
              </div>
              {(customStartDate || customEndDate) && (
                <button
                  type="button"
                  onClick={() => { setCustomStartDate(""); setCustomEndDate(""); }}
                  className="text-[11px] text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200 underline font-semibold cursor-pointer ml-1"
                >
                  Reset Dates
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="w-full mt-4 border border-slate-200 dark:border-[#163657] rounded-xl bg-white dark:bg-[#061424] overflow-hidden shadow-xs dark:shadow-inner">
        <div ref={tableContainerRef} className="overflow-x-auto w-full">
          <table className="min-w-[1180px] w-full text-xs text-left border-collapse table-auto">
            <thead className="bg-slate-50 dark:bg-[#081b30] border-b border-slate-200 dark:border-[#163657] text-slate-600 dark:text-slate-300 font-bold uppercase tracking-wider text-[10px] sticky top-0 z-10 select-none">
              <tr>
                <th 
                  scope="col" 
                  onClick={() => handleSort("id")}
                  className={`py-3 px-3 text-center w-12 border-r border-slate-200 dark:border-[#143252]/50 whitespace-nowrap cursor-pointer transition-colors group select-none text-[10px] font-bold uppercase tracking-wider ${
                    sortKey === "id" ? "bg-blue-50 text-blue-700 dark:bg-[#0c2847] dark:text-[#38bdf8] font-bold" : "hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-[#0b2440] dark:hover:text-white"
                  }`}
                  title="Click to sort by Number"
                >
                  <div className="flex items-center justify-center gap-1">
                    <span>#</span>
                    {renderSortIndicator("id")}
                  </div>
                </th>

                <th 
                  scope="col" 
                  onClick={() => handleSort("submitted")}
                  className={`py-3 px-3 border-r border-slate-200 dark:border-[#143252]/50 whitespace-nowrap cursor-pointer transition-colors group select-none text-[10px] font-bold uppercase tracking-wider ${
                    sortKey === "submitted" ? "bg-blue-50 text-blue-700 dark:bg-[#0c2847] dark:text-[#38bdf8] font-bold" : "hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-[#0b2440] dark:hover:text-white"
                  }`}
                  title="Click to sort by Submitted timestamp"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span>SUBMITTED</span>
                    {renderSortIndicator("submitted")}
                  </div>
                </th>

                <th 
                  scope="col" 
                  onClick={() => handleSort("driverName")}
                  className={`py-3 px-3 border-r border-slate-200 dark:border-[#143252]/50 whitespace-nowrap cursor-pointer transition-colors group select-none text-[10px] font-bold uppercase tracking-wider ${
                    sortKey === "driverName" ? "bg-blue-50 text-blue-700 dark:bg-[#0c2847] dark:text-[#38bdf8] font-bold" : "hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-[#0b2440] dark:hover:text-white"
                  }`}
                  title="Click to sort by Driver's Name"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span>DRIVER'S NAME</span>
                    {renderSortIndicator("driverName")}
                  </div>
                </th>

                <th
                  scope="col"
                  className="py-3 px-3 border-r border-slate-200 dark:border-[#143252]/50 whitespace-nowrap text-[10px] font-bold uppercase tracking-wider"
                >
                  PHONE
                </th>

                <th 
                  scope="col" 
                  onClick={() => handleSort("vrm")}
                  className={`py-3 px-3 border-r border-slate-200 dark:border-[#143252]/50 whitespace-nowrap cursor-pointer transition-colors group select-none text-[10px] font-bold uppercase tracking-wider ${
                    sortKey === "vrm" ? "bg-blue-50 text-blue-700 dark:bg-[#0c2847] dark:text-[#38bdf8] font-bold" : "hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-[#0b2440] dark:hover:text-white"
                  }`}
                  title="Click to sort by VRM"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span>VRM</span>
                    {renderSortIndicator("vrm")}
                  </div>
                </th>

                <th 
                  scope="col" 
                  onClick={() => handleSort("voucherCode")}
                  className={`py-3 px-3 border-r border-slate-200 dark:border-[#143252]/50 whitespace-nowrap cursor-pointer transition-colors group select-none text-[10px] font-bold uppercase tracking-wider ${
                    sortKey === "voucherCode" ? "bg-blue-50 text-blue-700 dark:bg-[#0c2847] dark:text-[#38bdf8] font-bold" : "hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-[#0b2440] dark:hover:text-white"
                  }`}
                  title="Click to sort by Voucher Code"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span>VOUCHER CODE</span>
                    {renderSortIndicator("voucherCode")}
                  </div>
                </th>

                <th 
                  scope="col" 
                  className="py-3 px-3 border-r border-slate-200 dark:border-[#143252]/50 whitespace-nowrap text-center select-none w-[90px] min-w-[90px] text-[10px] font-bold uppercase tracking-wider"
                >
                  <div className="flex items-center justify-center">
                    <span>CODES</span>
                  </div>
                </th>

                <th 
                  scope="col" 
                  onClick={() => handleSort("validFrom")}
                  className={`py-3 px-3 border-r border-slate-200 dark:border-[#143252]/50 whitespace-nowrap cursor-pointer transition-colors group select-none text-[10px] font-bold uppercase tracking-wider ${
                    sortKey === "validFrom" ? "bg-blue-50 text-blue-700 dark:bg-[#0c2847] dark:text-[#38bdf8] font-bold" : "hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-[#0b2440] dark:hover:text-white"
                  }`}
                  title="Click to sort by Valid From date"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span>VALID FROM</span>
                    {renderSortIndicator("validFrom")}
                  </div>
                </th>

                <th 
                  scope="col" 
                  onClick={() => handleSort("validTo")}
                  className={`py-3 px-3 border-r border-slate-200 dark:border-[#143252]/50 whitespace-nowrap cursor-pointer transition-colors group select-none text-[10px] font-bold uppercase tracking-wider ${
                    sortKey === "validTo" ? "bg-blue-50 text-blue-700 dark:bg-[#0c2847] dark:text-[#38bdf8] font-bold" : "hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-[#0b2440] dark:hover:text-white"
                  }`}
                  title="Click to sort by Valid To date"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span>VALID TO</span>
                    {renderSortIndicator("validTo")}
                  </div>
                </th>

                <th 
                  scope="col" 
                  onClick={() => handleSort("ward")}
                  className={`py-3 px-3 border-r border-slate-200 dark:border-[#143252]/50 whitespace-nowrap cursor-pointer transition-colors group select-none text-[10px] font-bold uppercase tracking-wider ${
                    sortKey === "ward" ? "bg-blue-50 text-blue-700 dark:bg-[#0c2847] dark:text-[#38bdf8] font-bold" : "hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-[#0b2440] dark:hover:text-white"
                  }`}
                  title="Click to sort by Ward"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span>WARD</span>
                    {renderSortIndicator("ward")}
                  </div>
                </th>

                <th 
                  scope="col" 
                  onClick={() => handleSort("hospital")}
                  className={`py-3 px-3.5 border-r border-slate-200 dark:border-[#143252]/50 whitespace-nowrap min-w-[185px] cursor-pointer transition-colors group select-none text-[10px] font-bold uppercase tracking-wider ${
                    sortKey === "hospital" ? "bg-blue-50 text-blue-700 dark:bg-[#0c2847] dark:text-[#38bdf8] font-bold" : "hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-[#0b2440] dark:hover:text-white"
                  }`}
                  title="Click to sort by Hospital Site"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span>HOSPITAL</span>
                    {renderSortIndicator("hospital")}
                  </div>
                </th>

                <th 
                  scope="col" 
                  onClick={() => handleSort("status")}
                  className={`py-3 px-3 text-center border-r border-slate-200 dark:border-[#143252]/50 whitespace-nowrap cursor-pointer transition-colors group select-none text-[10px] font-bold uppercase tracking-wider ${
                    sortKey === "status" ? "bg-blue-50 text-blue-700 dark:bg-[#0c2847] dark:text-[#38bdf8] font-bold" : "hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-[#0b2440] dark:hover:text-white"
                  }`}
                  title="Click to sort by Status"
                >
                  <div className="flex items-center justify-center gap-1">
                    <span>STATUS</span>
                    {renderSortIndicator("status")}
                  </div>
                </th>

                <th 
                  scope="col" 
                  onClick={() => handleSort("actions")}
                  className={`py-3 px-3 text-center whitespace-nowrap cursor-pointer transition-colors group select-none text-[10px] font-bold uppercase tracking-wider ${
                    sortKey === "actions" ? "bg-blue-50 text-blue-700 dark:bg-[#0c2847] dark:text-[#38bdf8] font-bold" : "hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-[#0b2440] dark:hover:text-white"
                  }`}
                  title="Click to sort by Action state"
                >
                  <div className="flex items-center justify-center gap-1">
                    <span>ACTIONS</span>
                    {renderSortIndicator("actions")}
                  </div>
                </th>

                <th 
                  scope="col" 
                  className="py-3 px-1.5 w-[76px] max-w-[76px] text-center border-l border-slate-200 dark:border-[#143252]/50 whitespace-nowrap select-none text-[9px] font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200"
                >
                  <div className="flex items-center justify-center gap-1">
                    <span>REPEAT USER</span>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-[#102947]">
              {virtualizer.isVirtual && virtualizer.topSpacerHeight > 0 && (
                <tr aria-hidden="true" style={{ height: `${virtualizer.topSpacerHeight}px` }}>
                  <td colSpan={14} style={{ padding: 0, border: 0 }} />
                </tr>
              )}
              {paginatedRecords.map((record, pIdx) => {
                const index = (virtualizer.isVirtual ? virtualizer.startIndex : startIndex) + pIdx;
                const recordIso = parseDateToISO(record?.dateRequired || record?.validFrom);
                const expiresIso = recordIso ? addDays(recordIso, 6) : "";

                const reqDate = getRequestedPermitDateISO(record, processingDate);
                const isBlocked = isVrmSilentBlockedSync(record?.vrm);
                const isCancelled = getIsCancelled(record, index);
                const recordKey = String(record?.formId || record?.id || index);

                // ⭐ FIX: CODES Column & VOUCHER CODE Column - canonical date range matching
                const permitFromISO = getRequestedPermitDateISO(record) || parseDateToISO(record?.validFrom || record?.dateRequired) || "";
                const permitToISO = (() => {
                  if (record?.validTo) {
                    const iso = parseDateToISO(record.validTo);
                    if (iso) return iso;
                  }
                  if (record?.dateExpiry) {
                    const iso = parseDateToISO(record.dateExpiry);
                    if (iso) return iso;
                  }
                  const rawDate = record?.dateRequired || record?.validFrom;
                  if (rawDate) {
                    const range = parseDateRange(String(rawDate));
                    if (range && range.endISO) {
                      return range.endISO;
                    }
                  }
                  if (permitFromISO) {
                    return addDays(permitFromISO, 6);
                  }
                  return "";
                })();

                const isDispatched = checkIsRecordDispatched(record, record?.vrm, record?.driverName, record?.dateRequired, dispatchedKeysSet, unsentKeysSet);
                const isDisp = isDispatched;
                const replacementPending = !isBlocked && !isDisp && isReplacementPending(record);
                const recordPk = getRecordPrimaryKey(record) || record?.vrm || String(record?.id || "");
                const cleanVrmKey = record?.vrm ? record.vrm.toUpperCase().replace(/\s+/g, "") : "";
                const trackInfo = emailTracking?.[recordPk] || (cleanVrmKey ? emailTracking?.[cleanVrmKey] : undefined) || (record?.formId ? emailTracking?.[String(record.formId)] : undefined);
                let displayCode = recordCodeMap.get(recordKey);

                if (isBlocked) {
                  displayCode = "BLOCKED";
                } else if (isCancelled) {
                  displayCode = "CANCELLED";
                } else if (replacementPending) {
                  displayCode = record.replacementCode || (isSameSelectedRecord(record) && formData?.voucherCodesText ? formData.voucherCodesText : (recordCodeMap.get(recordKey) || record.voucherCode || "-"));
                } else if (displayCode === undefined || displayCode === null || displayCode === "CANCELLED" || displayCode === "BLOCKED") {
                  const cleanVrmStr = record?.vrm ? String(record.vrm).toUpperCase().replace(/\s+/g, "") : "";
                  const hasStableId = Boolean(
                    (record?.formId !== undefined && record?.formId !== null && String(record?.formId).trim() !== "") ||
                    (record?.id !== undefined && record?.id !== null && String(record?.id).trim() !== "")
                  );
                  const rawCode = String(
                    record.voucherCode ||
                    (customVouchers && (
                      customVouchers[recordKey] ||
                      (record.formId ? customVouchers[String(record.formId)] : undefined) ||
                      (record.id ? customVouchers[String(record.id)] : undefined) ||
                      (!hasStableId && !isPlaceholderVrm(cleanVrmStr) ? (customVouchers[`${cleanVrmStr}_${reqDate}`] || customVouchers[cleanVrmStr]) : undefined)
                    )) ||
                    ""
                  ).trim();
                  const cleanRaw = cleanVoucherCodeValue(rawCode).toUpperCase();
                  
                  // ⭐ O(1) check if code exists in current vouchersDatabase
                  const codeExists = cleanRaw && cleanRaw !== "-" && cleanRaw !== "CANCELLED" && cleanRaw !== "BLOCKED" &&
                    voucherIndex.codeMap.has(cleanRaw);
                  
                  displayCode = codeExists ? rawCode : "-";
                }

                // Every displayed voucher code must come from the loaded Vouchers.csv
                // and match this permit's VALIDFROM/VALIDTO range. Never trust a
                // stale Supabase/custom/replacement value.
                if (
                  displayCode &&
                  displayCode !== "-" &&
                  displayCode !== "CANCELLED" &&
                  displayCode !== "BLOCKED"
                ) {
                  const cleanDisplay = cleanVoucherCodeValue(displayCode).toUpperCase();
                  const candidates = vouchersDatabase && vouchersDatabase.length > 0
                    ? voucherIndex.codeMap.get(cleanDisplay)
                    : undefined;

                  const validInCsvForDate = Boolean(
                    candidates &&
                    permitFromISO &&
                    permitToISO &&
                    candidates.some(v =>
                      isVoucherForPermitDateRange(v, permitFromISO, permitToISO)
                    )
                  );

                  if (!validInCsvForDate) {
                    displayCode = "-";
                  }
                }
                const rowKey = String(record.formId ?? record.id ?? record.vrm ?? index);

                const excelId = (() => {
                  if (record.formId !== undefined && record.formId !== null) {
                    const s = String(record.formId).trim();
                    if (s && s !== "-" && !s.startsWith("row-")) return s;
                  }
                  if (record.id !== undefined && record.id !== null) {
                    const s = String(record.id).trim();
                    if (s && s !== "-" && !s.startsWith("row-")) return s;
                  }
                  return String(index + 1);
                })();

                const hospitalDisplay = getHospital(record);

                // ⭐ Stale code check using indexed lookup
                const cleanUpperDisplay = String(displayCode || "").trim().toUpperCase();
                const candidatesForDisplay = voucherIndex.codeMap.get(cleanUpperDisplay);
                const isStaleCode = Boolean(
                  !isBlocked &&
                  !isCancelled &&
                  displayCode &&
                  displayCode !== "-" &&
                  (!candidatesForDisplay || !candidatesForDisplay.some(v => isVoucherForPermitDateRange(v, permitFromISO, permitToISO)))
                );
                
                // ⭐ Instant O(1) memoized voucher stock calculation
                const { total: totalForRow, remaining: remainingForRow } = getRowVoucherStats(permitFromISO, permitToISO, record?.vrm || "");
                
                const percentRemainingRow = totalForRow > 0
                  ? (remainingForRow / totalForRow) * 100
                  : 0;
                
                // 🔴 RED if: total=0 OR remaining≤5 OR percentage≤5%
                const isRowStockLow = totalForRow === 0 || remainingForRow <= 5 || percentRemainingRow <= 5;

                const isSelectedRow = Boolean(activeRecord && isRecordMatch(record, activeRecord));

                return (
                  <tr 
                    key={`dispatch_${rowKey}_${index}`}
                    onClick={() => handleRowClick(record)}
                    className={`transition-colors cursor-pointer text-slate-800 dark:text-slate-200 ${
                      isSelectedRow
                        ? "bg-blue-50/80 dark:bg-[#0c2847]/90 font-medium ring-1 ring-inset ring-blue-500/30 dark:ring-blue-400/30"
                        : "hover:bg-blue-50/50 dark:hover:bg-[#0c233d]/70"
                    }`}
                  >
                    <td className="py-3 px-3 text-center text-slate-500 dark:text-slate-400 font-mono font-normal border-r border-slate-100 dark:border-[#102947]/60 whitespace-nowrap text-[10px]">
                      {excelId}
                    </td>

                    <td className="py-3 px-3 font-mono font-normal text-slate-700 dark:text-slate-200 border-r border-slate-100 dark:border-[#102947]/60 whitespace-nowrap text-[10px]">
                      {formatSubmittedDateTime(record)}
                    </td>

                    <td className="py-3 px-3 font-normal text-slate-900 dark:text-white border-r border-slate-100 dark:border-[#102947]/60 whitespace-nowrap text-[10px] relative">
                      <div className="flex items-center gap-1.5">
                        <span>{record.driverName ? toTitleCase(String(record.driverName)) : "-"}</span>
                      </div>
                    </td>

                    <td className="py-3 px-3 font-normal text-slate-700 dark:text-slate-200 border-r border-slate-100 dark:border-[#102947]/60 whitespace-nowrap text-[10px]">
                      {record.phone || "-"}
                    </td>

                    <td className="py-3 px-3 font-mono font-normal text-slate-900 dark:text-white uppercase border-r border-slate-100 dark:border-[#102947]/60 whitespace-nowrap text-[10px]">
                      {record.vrm ? String(record.vrm).toUpperCase() : "-"}
                    </td>

                    <td className="py-3 px-3 font-mono font-normal border-r border-slate-100 dark:border-[#102947]/60 whitespace-nowrap text-[10px]">
                      {isBlocked ? (
                        <span className="text-rose-600 dark:text-rose-400 font-normal">
                          BLOCKED
                        </span>
                      ) : (isCancelled || displayCode === "CANCELLED") ? (
                        <span className="text-red-600 dark:text-[#FF453A] font-normal">
                          CANCELLED
                        </span>
                      ) : replacementPending ? (
                        <span className="text-amber-600 dark:text-amber-400 font-bold bg-amber-50 dark:bg-amber-950/30 px-2 py-0.5 rounded border border-amber-200 dark:border-amber-700/50 inline-flex items-center gap-1.5">
                          <span className="inline-block animate-spin text-[10px]">⟳</span>
                          {displayCode || "-"}
                        </span>
                      ) : isStaleCode ? (
                        <span 
                          className="text-orange-600 dark:text-orange-400 font-normal inline-flex items-center gap-1"
                          title="This code isn't in the currently loaded voucher batch for this date range — likely assigned before the latest Vouchers.csv was uploaded."
                        >
                          <span aria-hidden="true">⚠</span>
                          {displayCode}
                        </span>
                      ) : (
                        <span className="text-slate-800 dark:text-slate-200 font-normal">
                          {displayCode || "-"}
                        </span>
                      )}
                    </td>

                    {/* ⭐ FIXED CODES COLUMN - Shows count, not VRM */}
                    <td className="py-3 px-3 border-r border-slate-100 dark:border-[#102947]/60 whitespace-nowrap text-center text-[10px]">
                      <div className="flex flex-col items-center justify-center gap-1 mx-auto w-[74px]">
                        <div 
                          className="w-[74px] h-[5px] rounded overflow-hidden"
                          style={{ backgroundColor: isRowStockLow ? "#fee2e2" : "#dcfce7" }}
                        >
                          <div 
                            className="h-full rounded transition-all duration-300"
                            style={{ 
                              width: `${Math.min(100, Math.max(0, percentRemainingRow))}%`,
                              backgroundColor: isRowStockLow ? "#dc2626" : "#16a34a" 
                            }} 
                          />
                        </div>
                        <span 
                          className="text-[9px] font-medium leading-none select-none tracking-tight"
                          style={{ color: isRowStockLow ? "#b91c1c" : "#15803d" }}
                        >
                          {remainingForRow} left
                        </span>
                      </div>
                    </td>

                    <td className="py-3 px-3 font-mono font-normal text-slate-700 dark:text-slate-200 border-r border-slate-100 dark:border-[#102947]/60 whitespace-nowrap text-[10px]">
                      {formatDate(record?.dateRequired || record?.validFrom)}
                    </td>

                    <td className="py-3 px-3 font-mono font-normal text-slate-700 dark:text-slate-200 border-r border-slate-100 dark:border-[#102947]/60 whitespace-nowrap text-[10px]">
                      {formatDate(record?.validTo || record?.dateExpiry || expiresIso)}
                    </td>

                    <td className="py-3 px-3 font-normal text-slate-700 dark:text-slate-200 border-r border-slate-100 dark:border-[#102947]/60 whitespace-nowrap text-[10px]">
                      {record.ward ? toTitleCase(String(record.ward)) : "-"}
                    </td>

                    <td className="py-3 px-3.5 font-normal text-slate-700 dark:text-slate-200 border-r border-slate-100 dark:border-[#102947]/60 whitespace-nowrap min-w-[185px] text-[10px]">
                      {hospitalDisplay}
                    </td>

                    <td className="py-3 px-3 text-center border-r border-slate-100 dark:border-[#102947]/60 select-none whitespace-nowrap text-[10px]">
                      {isBlocked ? (
                        <span className="border border-rose-300 dark:border-rose-800/60 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 font-bold px-2 py-0.5 rounded text-[9px] tracking-wider uppercase inline-flex items-center justify-center whitespace-nowrap">
                          BLOCKED
                        </span>
                      ) : (isCancelled || (record.status && String(record.status).trim().toUpperCase() === "CANCELLED")) ? (
                        <span className="border border-red-300 dark:border-red-800/60 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 font-bold px-2 py-0.5 rounded text-[9px] tracking-wider uppercase inline-flex items-center justify-center whitespace-nowrap">
                          CANCELLED
                        </span>
                      ) : isDispatched ? (
                        <span 
                          title={trackInfo?.sentAt ? `Dispatched & sent: ${new Date(trackInfo.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : "Dispatched"}
                          className="border border-emerald-300 dark:border-[#32D74B]/40 bg-emerald-50 dark:bg-[#32D74B]/15 text-emerald-700 dark:text-[#32D74B] font-bold px-2 py-0.5 rounded text-[9px] tracking-wider uppercase inline-flex items-center justify-center gap-1 whitespace-nowrap"
                        >
                          <span>✅</span>
                          <span>SENT</span>
                        </span>
                      ) : replacementPending ? (
                        <span className="border border-amber-400 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 font-bold px-2 py-0.5 rounded text-[9px] tracking-wider uppercase inline-flex items-center justify-center gap-1.5 whitespace-nowrap animate-pulse">
                          <span className="inline-block animate-spin text-[9px]">⟳</span>
                          REPLACEMENT
                        </span>
                      ) : (
                        <span className="border border-amber-300 dark:border-[#FF9F0A]/40 bg-amber-50 dark:bg-[#FF9F0A]/15 text-amber-700 dark:text-[#FF9F0A] font-bold px-2 py-0.5 rounded text-[9px] tracking-wider uppercase inline-flex items-center justify-center whitespace-nowrap">
                          PENDING
                        </span>
                      )}
                    </td>

                    <td className="py-3 px-3 text-center whitespace-nowrap text-[10px]" onClick={e => e.stopPropagation()}>
                      <div className="inline-flex items-center justify-center gap-1.5 rounded-md">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedRowRecord(record);
                            onSelectRecord(record);
                            if (onEditRecord) {
                              // Pass the actually-displayed voucher code (resolved via recordCodeMap),
                              // not just the raw record.voucherCode field, which is often blank —
                              // the Edit modal needs the real assigned code to filter it out of
                              // its own Active Date Codes list correctly.
                              const resolvedCode =
                                displayCode && displayCode !== "-" && displayCode !== "CANCELLED" && displayCode !== "BLOCKED"
                                  ? displayCode
                                  : "";
                              const finalVoucherForRecord = isCancelled
                                ? "CANCELLED"
                                : (isBlocked ? "BLOCKED" : resolvedCode);
                              onEditRecord(
                                {
                                  ...record,
                                  voucherCode: finalVoucherForRecord,
                                  prePaidCode: finalVoucherForRecord,
                                  status: isDispatched ? "SENT" : (record.status || "PENDING"),
                                  isDispatched
                                },
                                resolvedCode
                              );
                            } else {
                              onSelectRecord(record);
                            }
                          }}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded shadow-xs hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer transition-colors"
                          title="Edit Record"
                        >
                          <Pencil className="w-2.5 h-2.5 text-slate-500 dark:text-slate-400" />
                          <span>Edit</span>
                        </button>
                        {(() => {
                          const splitActionClasses = isBlocked
                            ? {
                                main: "bg-slate-400 dark:bg-slate-700 cursor-not-allowed opacity-60",
                                chevron: "bg-slate-400 dark:bg-slate-700 cursor-not-allowed opacity-60 border-l border-slate-500/50",
                              }
                            : replacementPending
                              ? {
                                  main: "cursor-pointer bg-amber-600 hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-700",
                                  chevron: "cursor-pointer bg-amber-600 hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-700 border-l border-amber-700/60",
                                }
                              : isDispatched
                                ? {
                                    main: "cursor-pointer bg-[#dc2626] hover:bg-[#b91c1c]",
                                    chevron: "cursor-pointer bg-[#dc2626] hover:bg-[#b91c1c] border-l border-[#b91c1c]",
                                  }
                                : {
                                    main: "cursor-pointer bg-[#1d75f2] hover:bg-[#1565d8]",
                                    chevron: "cursor-pointer bg-[#1d75f2] hover:bg-[#1565d8] border-l border-[#1565d8]",
                                  };

                          return (
                            <div className="inline-flex items-center gap-1.5">
                              <div className="inline-flex items-center justify-center rounded-md overflow-hidden shadow-xs">
                                <button 
                                  type="button" 
                                  disabled={busyKey === rowKey || isBlocked} 
                                  onClick={() => { if (!isBlocked) handleAction(record, isDispatched, replacementPending); }} 
                                  title={isBlocked ? "This VRM is on the Manage Blocklist — dispatch disabled" : undefined}
                                  className={`flex items-center gap-1 px-2 py-0.5 text-white text-[10px] font-medium transition-colors disabled:opacity-50 whitespace-nowrap ${splitActionClasses.main}`}
                                >
                                  {busyKey === rowKey ? (
                                    <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                                  ) : (
                                    replacementPending ? (
                                      <span className="inline-block animate-spin text-[10px]">⟳</span>
                                    ) : (
                                      <Mail className="w-2.5 h-2.5" />
                                    )
                                  )}
                                  <span>{isBlocked ? "Blocked" : (replacementPending ? "Resend" : (isDispatched ? "Unsend" : "Send"))}</span>
                                </button>
                                <button 
                                  type="button" 
                                  disabled={isBlocked}
                                  onClick={() => { if (!isBlocked) onSelectRecord(record); }} 
                                  className={`px-1.5 py-0.5 text-white transition-colors ${splitActionClasses.chevron}`}
                                  title={isBlocked ? "Disabled" : "Select Record"}
                                >
                                  <ChevronDown className="w-2.5 h-2.5" />
                                </button>
                              </div>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (onPreviewRecord) {
                                    onPreviewRecord(record);
                                  } else {
                                    onSelectRecord?.(record);
                                  }
                                }}
                                title="Preview Permit Card"
                                className="p-1 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors cursor-pointer"
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          );
                        })()}
                      </div>
                    </td>

                    {/* Repeat User — compact derived-data indicator; no extra database requests */}
                    <td className="py-3 px-1.5 w-[76px] max-w-[76px] text-center border-l border-slate-100 dark:border-[#102947]/60 whitespace-nowrap text-[10px]" onClick={e => e.stopPropagation()}>
                      {(() => {
                        const rKey = String(record.formId ?? record.id ?? `${record.vrm}_${record.dateRequired}_${index}`);
                        const identifier = recordToUserMap.get(rKey);
                        if (!identifier) return null;

                        const userEntry = userSubmissionsMap.get(identifier);
                        if (!userEntry || userEntry.count < 1) return null;

                        const popoverKey = `repeat_user_${rowKey}`;
                        const isPopoverOpen = activeUserPopoverKey === popoverKey;
                        const firstSubStr = userEntry.firstSubmissionMs > 0 ? new Date(userEntry.firstSubmissionMs).toLocaleDateString("en-GB") : "-";
                        const latestSubStr = userEntry.latestSubmissionMs > 0 ? new Date(userEntry.latestSubmissionMs).toLocaleDateString("en-GB") : "-";

                        return (
                          <div className="relative inline-block" onClick={e => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isPopoverOpen) {
                                  setActiveUserPopoverKey(null);
                                  setPopoverAnchorRect(null);
                                } else {
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  setPopoverAnchorRect(rect);
                                  setActiveUserPopoverKey(popoverKey);
                                }
                              }}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-blue-600/20 hover:bg-blue-600/30 text-blue-500 dark:text-blue-300 border border-blue-500/30 font-mono text-[9px] font-bold transition-colors cursor-pointer select-none"
                              title={`Repeat User: ${userEntry.count} concession form submissions`}
                              aria-label={`${userEntry.displayName}: ${userEntry.count} concession form submissions`}
                            >
                              <User className="w-3 h-3" aria-hidden="true" />
                              <span>×{userEntry.count}</span>
                            </button>

                            {isPopoverOpen && popoverAnchorRect && createPortal(
                              <div
                                ref={popoverRef}
                                className="fixed z-[99999] w-56 bg-white dark:bg-[#071b30] border border-slate-200 dark:border-[#1e436c] rounded-lg shadow-xl p-3 text-left font-normal"
                                style={{
                                  ...(popoverAnchorRect.top < 220 ? {
                                    top: `${popoverAnchorRect.bottom + 6}px`,
                                  } : {
                                    bottom: `${window.innerHeight - popoverAnchorRect.top + 6}px`,
                                  }),
                                  right: `${Math.max(12, window.innerWidth - popoverAnchorRect.right)}px`
                                }}
                                onClick={e => e.stopPropagation()}
                              >
                                <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-100 dark:border-[#132A4A]">
                                  <span className="font-semibold text-slate-900 dark:text-white text-[10px]">Repeat User Details</span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setActiveUserPopoverKey(null);
                                      setPopoverAnchorRect(null);
                                    }}
                                    className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 p-0.5 cursor-pointer"
                                    aria-label="Close repeat user details"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>

                                <div className="font-semibold text-slate-900 dark:text-white text-[11px] truncate">{userEntry.displayName}</div>
                                {userEntry.email && (
                                  <div className="text-[9px] text-slate-500 dark:text-slate-400 font-mono truncate mt-0.5 mb-2.5">{userEntry.email}</div>
                                )}

                                <div className="rounded-md bg-slate-50 dark:bg-[#041222] border border-slate-100 dark:border-[#132A4A] p-2 mb-2.5">
                                  <div className="text-[9px] text-slate-500 dark:text-slate-400">Total concessions submitted</div>
                                  <div className="text-right text-lg leading-none font-bold text-blue-600 dark:text-blue-400 font-mono mt-1">{userEntry.count}</div>
                                </div>

                                <div className="space-y-1.5 text-[9px] text-slate-600 dark:text-slate-300">
                                  <div className="flex justify-between gap-3">
                                    <span>First submission</span>
                                    <span className="font-mono text-slate-900 dark:text-white">{firstSubStr}</span>
                                  </div>
                                  <div className="flex justify-between gap-3">
                                    <span>Latest submission</span>
                                    <span className="font-mono text-slate-900 dark:text-white">{latestSubStr}</span>
                                  </div>
                                </div>
                              </div>,
                              document.body
                            )}
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                );
              })}
              {virtualizer.isVirtual && virtualizer.bottomSpacerHeight > 0 && (
                <tr aria-hidden="true" style={{ height: `${virtualizer.bottomSpacerHeight}px` }}>
                  <td colSpan={14} style={{ padding: 0, border: 0 }} />
                </tr>
              )}
              {filteredRecords.length === 0 && (
                <tr>
                  <td colSpan={14} className="py-12 text-center text-slate-500 dark:text-slate-400 text-xs">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Filter className="w-6 h-6 text-slate-400 stroke-1" />
                      <p className="font-semibold text-sm text-slate-700 dark:text-slate-300">No matching permits found</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {isFiltered ? "Try adjusting or clearing your active filters." : `No records found for date ${formatDate(processingDate)}.`}
                      </p>
                      {isFiltered && (
                        <button
                          type="button"
                          onClick={handleClearAllFilters}
                          className="mt-2 px-3 py-1.5 text-xs bg-blue-50 dark:bg-[#0c2847] text-blue-600 dark:text-[#38bdf8] hover:bg-blue-100 rounded-lg font-medium border border-blue-200 dark:border-[#1e436c] transition cursor-pointer"
                        >
                          Clear all filters
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-center justify-between gap-3.5 mt-3 px-1 text-xs text-slate-600 dark:text-slate-300">
        <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto justify-between sm:justify-start">
          <div className="font-medium text-slate-700 dark:text-slate-300">
            Showing <span className="font-semibold text-slate-900 dark:text-white">{totalFilteredCount === 0 ? 0 : (startIndex + 1).toLocaleString()}</span>
            {" – "}
            <span className="font-semibold text-slate-900 dark:text-white">{endIndex.toLocaleString()}</span> of{" "}
            <span className="font-semibold text-slate-900 dark:text-white">{totalFilteredCount.toLocaleString()}</span> permits
          </div>

          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            <span>Rows per page:</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setCurrentPage(1);
              }}
              className="px-2 py-1 bg-white dark:bg-[#071b30] border border-slate-300 dark:border-[#1d436e] rounded-md text-slate-800 dark:text-slate-200 font-medium focus:outline-none focus:border-blue-500 cursor-pointer"
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={0}>All ({totalFilteredCount})</option>
            </select>
          </div>
        </div>

        {totalPages > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 w-full sm:w-auto justify-center sm:justify-end">
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border font-medium text-xs transition cursor-pointer ${
                safePage <= 1
                  ? "opacity-40 cursor-not-allowed bg-slate-100 dark:bg-[#061424] border-slate-200 dark:border-[#122b47] text-slate-400"
                  : "bg-white dark:bg-[#071b30] hover:bg-slate-100 dark:hover:bg-[#0c2847] border-slate-300 dark:border-[#1e436c] text-slate-700 dark:text-slate-200 shadow-2xs"
              }`}
              title="Previous Page"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Prev</span>
            </button>

            <div className="inline-flex items-center gap-1">
              {pageNumbers.map((p, idx) => {
                if (typeof p === "string") {
                  return (
                    <span key={`ellipsis-${idx}`} className="px-1 text-slate-400 font-medium select-none">
                      ...
                    </span>
                  );
                }
                const isActive = p === safePage;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setCurrentPage(p)}
                    className={`min-w-[32px] h-8 px-2 rounded-lg text-xs font-medium transition cursor-pointer ${
                      isActive
                        ? "bg-blue-600 text-white shadow-sm shadow-blue-500/30"
                        : "bg-white dark:bg-[#071b30] hover:bg-slate-100 dark:hover:bg-[#0c2847] border border-slate-300 dark:border-[#1e436c] text-slate-700 dark:text-slate-200"
                    }`}
                  >
                    {p}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border font-medium text-xs transition cursor-pointer ${
                safePage >= totalPages
                  ? "opacity-40 cursor-not-allowed bg-slate-100 dark:bg-[#061424] border-slate-200 dark:border-[#122b47] text-slate-400"
                  : "bg-white dark:bg-[#071b30] hover:bg-slate-100 dark:hover:bg-[#0c2847] border-slate-300 dark:border-[#1e436c] text-slate-700 dark:text-slate-200 shadow-2xs"
              }`}
              title="Next Page"
            >
              <span>Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>

            <form onSubmit={handleGoToPage} className="flex items-center gap-1 ml-1 sm:ml-2">
              <span className="text-[11px] text-slate-500 dark:text-slate-400">Go to:</span>
              <input
                type="number"
                min={1}
                max={totalPages}
                value={goToPageInput}
                onChange={(e) => setGoToPageInput(e.target.value)}
                placeholder={`${safePage}`}
                className="w-12 h-8 px-1.5 text-center bg-white dark:bg-[#071b30] border border-slate-300 dark:border-[#1e436c] rounded-lg text-xs text-slate-900 dark:text-white font-mono focus:outline-none focus:border-blue-500"
              />
              <button
                type="submit"
                className="h-8 px-2 bg-slate-100 hover:bg-slate-200 dark:bg-[#0c2847] dark:hover:bg-[#12365e] border border-slate-300 dark:border-[#1e436c] text-slate-700 dark:text-slate-200 rounded-lg text-xs font-medium transition cursor-pointer"
              >
                Go
              </button>
            </form>
          </div>
        )}
      </div>
    </section>
  );
}

export const DispatchCentre = React.memo(DispatchCentreComponent);
