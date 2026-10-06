import type { ParsedVoucherData, CsvPermitRecord } from "./csvParser";

export function cleanVoucherCodeValue(val: any): string {
  if (val === undefined || val === null) return "-";
  const s = String(val).trim();
  if (!s || s === "") return "-";
  
  const num = Number(s);
  if (!isNaN(num)) {
    if (s.includes(".") || (num > 30000 && num < 60000)) {
      return "-";
    }
  }

  const lower = s.toLowerCase();
  if (
    lower === "pending" || 
    lower === "none" || 
    lower === "null" || 
    lower === "undefined" || 
    lower === "-" || 
    lower === "—" ||
    lower === "blocked" ||
    lower === "expired" ||
    lower === "cancelled" ||
    lower === "canceled" ||
    lower === "cz7o274wedacs" ||
    lower === "29s54wndiefeg" ||
    lower.includes("cz7o") ||
    lower.includes("29s5") ||
    lower.includes("hospital") || 
    lower.includes("site") || 
    lower.includes("ward") || 
    lower.includes("department")
  ) {
    return "-";
  }

  return s.toUpperCase();
}

/**
 * Normalizes any date string (ISO YYYY-MM-DD or UK DD/MM/YYYY) into ISO YYYY-MM-DD.
 */
export function normalizeDateToISO(dateStr: string | undefined | null): string {
  if (!dateStr) return "";
  const s = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Check UK DD/MM/YYYY or DD-MM-YYYY
  const ukMatch = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (ukMatch) {
    const day = ukMatch[1].padStart(2, "0");
    const month = ukMatch[2].padStart(2, "0");
    const year = ukMatch[3];
    return `${year}-${month}-${day}`;
  }

  // Fallback to Date parsing
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  return "";
}

/**
 * Adds days to an ISO date string (YYYY-MM-DD)
 */
export function addDaysISO(isoDate: string, days: number): string {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return "";
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(y, m - 1, d + days);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Extracts normalized validFrom from a voucher object
 */
export function getVoucherValidFromISO(v: ParsedVoucherData | undefined | null): string {
  if (!v) return "";
  const raw = v.validFrom || 
              (v as any).valid_from || 
              (v as any).ValidFrom || 
              (v as any).VALIDFROM ||
              (v as any)["Valid From"] ||
              (v as any).startDate || 
              (v as any).start_date || 
              (v as any).StartDate ||
              (v as any)["Start Date"] ||
              (v as any).date;
  if (raw) {
    const iso = normalizeDateToISO(String(raw));
    if (iso) return iso;
  }
  const toRaw = v.validTo || 
                (v as any).valid_to || 
                (v as any).ValidTo || 
                (v as any).VALIDTO ||
                (v as any)["Valid To"] ||
                (v as any).expiry_date || 
                (v as any).expiryDate ||
                (v as any)["Expiry Date"];
  if (toRaw) {
    const toIso = normalizeDateToISO(String(toRaw));
    if (toIso) {
      return addDaysISO(toIso, -6);
    }
  }
  return "";
}

/**
 * Extracts normalized validTo from a voucher object
 */
export function getVoucherValidToISO(v: ParsedVoucherData | undefined | null): string {
  if (!v) return "";
  const raw = v.validTo || 
              (v as any).valid_to || 
              (v as any).ValidTo || 
              (v as any).VALIDTO ||
              (v as any).expiry_date || 
              (v as any).expiryDate || 
              (v as any).expires || 
              (v as any).dateExpiry || 
              (v as any)["Expiry Date"] || 
              (v as any)["Valid To"] || 
              (v as any).endDate || 
              (v as any).end_date;
  if (raw) {
    const iso = normalizeDateToISO(String(raw));
    if (iso) return iso;
  }
  const fromIso = getVoucherValidFromISO(v);
  if (fromIso) {
    return addDaysISO(fromIso, 6);
  }
  return "";
}

/**
 * Check if a voucher belongs to a specific permit date range
 */
export function isVoucherForPermitDateRange(
  v: ParsedVoucherData | undefined | null,
  permitFromISO: string,
  permitToISO?: string
): boolean {
  if (!v || !v.code || !permitFromISO) return false;
  const cleanCode = cleanVoucherCodeValue(v.code).toUpperCase();
  if (!cleanCode || cleanCode === "-" || cleanCode === "CANCELLED" || cleanCode === "PENDING" || cleanCode === "BLOCKED") {
    return false;
  }

  const normPermitFrom = normalizeDateToISO(permitFromISO);
  if (!normPermitFrom) return false;

  const vFrom = getVoucherValidFromISO(v);
  if (vFrom && vFrom !== normPermitFrom) {
    return false;
  }

  const normPermitTo = permitToISO ? normalizeDateToISO(permitToISO) : addDaysISO(normPermitFrom, 6);
  const vTo = getVoucherValidToISO(v);
  if (vTo && normPermitTo && vTo !== normPermitTo) {
    return false;
  }

  return true;
}

/**
 * Formats an ISO YYYY-MM-DD or standard date string to UK DD/MM/YYYY
 */
export function formatDateUK(dateStr: string | undefined | null): string {
  if (!dateStr) return "";
  const s = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-");
    return `${d}/${m}/${y}`;
  }
  const ukMatch = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (ukMatch) {
    return `${ukMatch[1].padStart(2, "0")}/${ukMatch[2].padStart(2, "0")}/${ukMatch[3]}`;
  }
  return s;
}

export interface ValidateManualVoucherResult {
  isValid: boolean;
  error?: string;
  matchingVoucher?: ParsedVoucherData;
}

/**
 * Validates manually changed/edited voucher codes using the canonical Active Date Codes
 * validation rules (isVoucherForPermitDateRange and allocation exclusion).
 */
export function validateManualVoucherChange(params: {
  origCode?: string | null;
  newCode?: string | null;
  permitDateRequired: string;
  permitDateExpiry?: string;
  vouchersDatabase?: ParsedVoucherData[] | null;
  assignedCodesInOtherRecords?: Set<string>;
}): ValidateManualVoucherResult {
  const {
    origCode,
    newCode,
    permitDateRequired,
    permitDateExpiry,
    vouchersDatabase,
    assignedCodesInOtherRecords
  } = params;

  const cleanOrig = cleanVoucherCodeValue(origCode || "").trim().toUpperCase();
  const cleanNew = cleanVoucherCodeValue(newCode || "").trim().toUpperCase();

  const isSpecialStatus = (code: string): boolean => {
    return (
      !code ||
      code === "-" ||
      code === "CANCELLED" ||
      code === "BLOCKED" ||
      code === "EXPIRED" ||
      code === "PENDING" ||
      code === "N/A"
    );
  };

  // Step 1 — Detect changed code. Unchanged codes or special non-voucher statuses pass through.
  if (!cleanNew || isSpecialStatus(cleanNew) || cleanNew === cleanOrig) {
    return { isValid: true };
  }

  // Step 2 — If the new code corresponds to a voucher in vouchersDatabase
  if (vouchersDatabase && vouchersDatabase.length > 0) {
    const matchingVoucher = vouchersDatabase.find(v => {
      if (!v || !v.code) return false;
      const c = cleanVoucherCodeValue(v.code).toUpperCase();
      return c === cleanNew;
    });

    if (matchingVoucher) {
      // Validate using EXACTLY isVoucherForPermitDateRange
      const isDateValid = isVoucherForPermitDateRange(
        matchingVoucher,
        permitDateRequired,
        permitDateExpiry || permitDateRequired
      );

      if (!isDateValid) {
        const vFromIso = getVoucherValidFromISO(matchingVoucher);
        const vToIso = getVoucherValidToISO(matchingVoucher);
        const vFromUK = formatDateUK(vFromIso);
        const vToUK = formatDateUK(vToIso);
        const pFromUK = formatDateUK(normalizeDateToISO(permitDateRequired));
        const pToUK = formatDateUK(normalizeDateToISO(permitDateExpiry || permitDateRequired));

        let msg = "This voucher code is not valid for the selected permit date range.";
        if (vFromUK && vToUK) {
          msg += `\n\nValid voucher dates:\n${vFromUK} – ${vToUK}`;
        }
        if (pFromUK && pToUK) {
          msg += `\n\nPermit date range:\n${pFromUK} – ${pToUK}`;
        }

        return {
          isValid: false,
          error: msg,
          matchingVoucher
        };
      }

      // Step 3 — Check whether the code is already assigned / used
      if (
        (assignedCodesInOtherRecords && assignedCodesInOtherRecords.has(cleanNew)) ||
        matchingVoucher.isUsed === true ||
        matchingVoucher.status === "used" ||
        matchingVoucher.status === "dispatched"
      ) {
        return {
          isValid: false,
          error: `This voucher code (${cleanNew}) is already assigned to another permit.`,
          matchingVoucher
        };
      }

      return { isValid: true, matchingVoucher };
    }
  }

  // Step 3 (cont.) — If code is not found in vouchersDatabase or no vouchersDatabase, verify not assigned to another active permit
  if (assignedCodesInOtherRecords && assignedCodesInOtherRecords.has(cleanNew)) {
    return {
      isValid: false,
      error: `This voucher code (${cleanNew}) is already assigned to another permit.`
    };
  }

  return { isValid: true };
}

/**
 * Validates whether a voucher code exists in the vouchers database (CSV).
 * Returns true if valid, false if invalid (or if not in database).
 * If no vouchers database is uploaded yet, returns true (permissive when empty).
 */
export function isVoucherInDatabase(
  code: string | undefined | null,
  vouchersDb: ParsedVoucherData[] | undefined | null,
  permitFromISO?: string,
  permitToISO?: string
): { isValid: boolean; reason?: "not_in_db" | "date_mismatch" | "empty" } {
  if (!code) return { isValid: false, reason: "empty" };
  const clean = cleanVoucherCodeValue(code).toUpperCase();
  if (!clean || clean === "-" || clean === "CANCELLED" || clean === "BLOCKED" || clean === "PENDING" || clean === "N/A") {
    return { isValid: false, reason: "empty" };
  }

  // If no vouchers database exists, cannot enforce
  if (!vouchersDb || vouchersDb.length === 0) {
    return { isValid: true };
  }

  // 1. Check if the code exists anywhere in vouchers database
  const matchingCodes = vouchersDb.filter(v => {
    if (!v || !v.code) return false;
    const vCode = cleanVoucherCodeValue(v.code).toUpperCase();
    return vCode === clean;
  });

  if (matchingCodes.length === 0) {
    return { isValid: false, reason: "not_in_db" };
  }

  // 2. If date range is specified, verify that at least one matching voucher is valid for this date
  if (permitFromISO) {
    const normFrom = normalizeDateToISO(permitFromISO);
    const normTo = permitToISO ? normalizeDateToISO(permitToISO) : addDaysISO(normFrom, 6);

    const matchesDate = matchingCodes.some(v => {
      const vFrom = getVoucherValidFromISO(v);
      const vTo = getVoucherValidToISO(v);
      if (!vFrom) return true; // generic voucher without explicit date
      if (vFrom !== normFrom) return false;
      if (normTo && vTo && vTo !== normTo) return false;
      return true;
    });

    if (!matchesDate) {
      return { isValid: false, reason: "date_mismatch" };
    }
  }

  return { isValid: true };
}

/**
 * Scan all permit records for codes not in the CSV database
 */
export interface InvalidVoucherRecord {
  record: CsvPermitRecord;
  code: string;
  formId?: string | number;
  vrm?: string;
  driverName?: string;
  validFrom?: string;
  validTo?: string;
  reason: "not_in_db" | "date_mismatch" | "empty";
}

export function scanForInvalidVouchers(
  database: CsvPermitRecord[],
  vouchersDb: ParsedVoucherData[]
): InvalidVoucherRecord[] {
  if (!database || !vouchersDb || vouchersDb.length === 0) return [];
  const invalid: InvalidVoucherRecord[] = [];

  database.forEach(record => {
    // Skip cancelled or blocked records
    if (
      record.isCancelled === true ||
      (typeof record.status === "string" && (record.status.toUpperCase() === "CANCELLED" || record.status.toUpperCase() === "BLOCKED"))
    ) {
      return;
    }

    const code = record.voucherCode || record.prePaidCode;
    if (!code) return;
    const clean = cleanVoucherCodeValue(code).toUpperCase();
    if (!clean || clean === "-" || clean === "CANCELLED" || clean === "BLOCKED" || clean === "PENDING" || clean === "N/A") {
      return;
    }

    const dateFrom = record.validFrom || record.dateRequired;
    const dateTo = record.validTo || record.dateExpiry;
    const result = isVoucherInDatabase(clean, vouchersDb, dateFrom, dateTo);

    if (!result.isValid && result.reason) {
      invalid.push({
        record,
        code: clean,
        formId: record.formId || record.id,
        vrm: record.vrm,
        driverName: record.driverName || record.name,
        validFrom: dateFrom,
        validTo: dateTo,
        reason: result.reason
      });
    }
  });

  return invalid;
}

/**
 * Finds the first unused valid voucher code from the CSV database for a given date range
 */
export function getFirstValidUnusedCodeForDate(
  vouchersDb: ParsedVoucherData[],
  database: CsvPermitRecord[],
  permitFromISO: string,
  permitToISO?: string,
  customVouchers?: Record<string, string>
): string | null {
  if (!vouchersDb || vouchersDb.length === 0 || !permitFromISO) return null;

  const normFrom = normalizeDateToISO(permitFromISO);
  const normTo = permitToISO ? normalizeDateToISO(permitToISO) : addDaysISO(normFrom, 6);

  // Collect all currently assigned codes in database
  const assignedCodes = new Set<string>();
  database.forEach(r => {
    if (r.isCancelled === true || (typeof r.status === "string" && r.status.toUpperCase() === "CANCELLED")) return;
    const raw = r.voucherCode || r.prePaidCode || r.qrCode || (r as any).voucherCodesText;
    if (raw) {
      const clean = cleanVoucherCodeValue(raw).toUpperCase();
      if (clean && clean !== "-" && clean !== "CANCELLED" && clean !== "BLOCKED" && clean !== "PENDING") {
        assignedCodes.add(clean);
      }
    }
  });

  if (customVouchers) {
    Object.values(customVouchers).forEach(raw => {
      if (raw) {
        const clean = cleanVoucherCodeValue(raw).toUpperCase();
        if (clean && clean !== "-" && clean !== "CANCELLED" && clean !== "BLOCKED") {
          assignedCodes.add(clean);
        }
      }
    });
  }

  // Filter vouchers that match this date and are not yet assigned
  const candidates = vouchersDb.filter(v => {
    if (!v || !v.code) return false;
    const cleanCode = cleanVoucherCodeValue(v.code).toUpperCase();
    if (!cleanCode || cleanCode === "-" || cleanCode === "CANCELLED" || cleanCode === "BLOCKED") return false;
    if (assignedCodes.has(cleanCode)) return false;

    // Check date match
    return isVoucherForPermitDateRange(v, normFrom, normTo);
  });

  if (candidates.length > 0) {
    return cleanVoucherCodeValue(candidates[0].code).toUpperCase();
  }

  // ⭐ No fallback. If no voucher exists for this exact date range,
  // return null so the caller shows 0 — never assign a voucher from
  // a different week's batch.
  return null;
}

export interface VoucherBatchBadgeResult {
  type: 'green' | 'amber' | 'red';
  icon: '🟢' | '⚠️' | '🔴';
  text: string;
  className: string;
  targetValidFromIso?: string;
  maxExpiryIso?: string;
  formattedDate?: string;
  daysDiff?: number;
}

/**
 * Calculates the voucher batch validity and warning state for the top-bar badge.
 * 1. Color Threshold Rules:
 *    - Green (> 3 days remaining):
 *      "🟢 Codes Valid Until: DD/MM/YYYY (X days left)"
 *    - Amber (1 to 3 days remaining):
 *      "⚠️ Voucher Batch Expiring Soon: DD/MM/YYYY (X days left)"
 *    - Red (0 days or batch expired):
 *      "🔴 No Active Codes Available — Add New Batch"
 * 2. Strict Date Calculation:
 *    - Strictly parses dates in local midnight time against system date (or referenceDate):
 *      const today = new Date(); today.setHours(0, 0, 0, 0);
 *      const validFromDate = new Date(activeCode.validFrom); validFromDate.setHours(0, 0, 0, 0);
 *      const daysLeft = Math.round((validFromDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
 */
export function computeVoucherBatchExpiryBadge(params: {
  vouchersDatabase?: ParsedVoucherData[];
  assignedVoucherCodesSet?: Set<string>;
  selectedHospital?: string;
  todayDateIso?: string;
  referenceDate?: Date;
}): VoucherBatchBadgeResult {
  const {
    vouchersDatabase = [],
    assignedVoucherCodesSet = new Set<string>(),
    selectedHospital = "",
    todayDateIso,
    referenceDate
  } = params;

  const redResult: VoucherBatchBadgeResult = {
    type: "red",
    icon: "🔴",
    text: "No Active Codes Available — Add New Batch",
    className: "text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-800/60"
  };

  if (!vouchersDatabase || vouchersDatabase.length === 0) {
    return redResult;
  }

  const availableVouchersForSite = vouchersDatabase.filter(v => {
    if (v.isUsed === true) return false;
    const status = String(v.status || "").toLowerCase().trim();
    if (
      status === "used" || 
      status === "dispatched" || 
      status === "assigned" || 
      status === "sent" || 
      status === "completed" || 
      status === "cancelled" || 
      status === "canceled" || 
      status === "expired"
    ) {
      return false;
    }

    const codeUpper = cleanVoucherCodeValue(v.code).toUpperCase();
    if (!codeUpper || codeUpper === "-" || codeUpper === "CANCELLED" || codeUpper === "PENDING" || codeUpper === "BLOCKED" || codeUpper === "N/A") {
      return false;
    }

    if (assignedVoucherCodesSet.has(codeUpper)) {
      return false;
    }

    if (selectedHospital && selectedHospital !== "ALL") {
      const vHosp = String(
        v.hospital || 
        v.site || 
        (v as any).hospitalSite || 
        (v as any).hospital_site || 
        (v as any).location || 
        ""
      ).trim().toLowerCase();

      if (vHosp) {
        const sel = selectedHospital.toLowerCase().trim();
        const isMatch = vHosp === sel ||
          (vHosp.includes("whipps") && sel.includes("whipps")) ||
          (vHosp.includes("newham") && sel.includes("newham")) ||
          (vHosp.includes("royal") && sel.includes("royal"));
        if (!isMatch) return false;
      }
    }

    return true;
  });

  if (availableVouchersForSite.length === 0) {
    return redResult;
  }

  // 1. Target Field Adjustment:
  // Force target date variable to use latest/active batch's 'VALIDFROM' (or valid_from / startDate).
  let targetValidFromIso = "";
  for (const v of availableVouchersForSite) {
    const fromIso = getVoucherValidFromISO(v);
    if (fromIso && /^\d{4}-\d{2}-\d{2}$/.test(fromIso)) {
      if (!targetValidFromIso || fromIso > targetValidFromIso) {
        targetValidFromIso = fromIso;
      }
    }
  }

  if (!targetValidFromIso) {
    return redResult;
  }

  // Determine the expiry date of the active/latest batch for expiration checking
  let batchExpiryIso = "";
  for (const v of availableVouchersForSite) {
    const fromIso = getVoucherValidFromISO(v);
    if (fromIso === targetValidFromIso) {
      const expIso = getVoucherValidToISO(v);
      if (expIso && /^\d{4}-\d{2}-\d{2}$/.test(expIso)) {
        if (!batchExpiryIso || expIso > batchExpiryIso) {
          batchExpiryIso = expIso;
        }
      }
    }
  }

  if (!batchExpiryIso && targetValidFromIso) {
    batchExpiryIso = addDaysISO(targetValidFromIso, 6);
  }

  // 2. Days Remaining Formula:
  // Parse date strictly in local midnight time:
  // const today = new Date(); today.setHours(0, 0, 0, 0);
  // const validFromDate = new Date(activeCode.validFrom); validFromDate.setHours(0, 0, 0, 0);
  // const daysLeft = Math.round((validFromDate - today) / (1000 * 60 * 60 * 24));
  let today = referenceDate ? new Date(referenceDate) : new Date();
  if (!referenceDate && todayDateIso) {
    const normToday = normalizeDateToISO(todayDateIso);
    if (normToday && /^\d{4}-\d{2}-\d{2}$/.test(normToday)) {
      const [ty, tm, td] = normToday.split("-").map(Number);
      today = new Date(ty, tm - 1, td);
    } else {
      today = new Date(todayDateIso);
    }
  }
  today.setHours(0, 0, 0, 0);

  let validFromDate: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(targetValidFromIso)) {
    const [vy, vm, vd] = targetValidFromIso.split("-").map(Number);
    validFromDate = new Date(vy, vm - 1, vd);
  } else {
    validFromDate = new Date(targetValidFromIso);
  }
  validFromDate.setHours(0, 0, 0, 0);

  const daysLeft = Math.round((validFromDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  // Determine batch expiry in local midnight time to detect fully expired batches
  let batchExpiryDate: Date | null = null;
  if (batchExpiryIso) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(batchExpiryIso)) {
      const [ey, em, ed] = batchExpiryIso.split("-").map(Number);
      batchExpiryDate = new Date(ey, em - 1, ed);
    } else {
      batchExpiryDate = new Date(batchExpiryIso);
    }
    batchExpiryDate.setHours(0, 0, 0, 0);
  }

  // 1. Color Threshold Rules:
  // - Red (0 days or batch expired): "🔴 No Active Codes Available — Add New Batch"
  if (batchExpiryDate && batchExpiryDate.getTime() < today.getTime()) {
    return redResult;
  }
  if (daysLeft <= 0) {
    return redResult;
  }

  // Format target validFrom date to DD/MM/YYYY
  const parts = targetValidFromIso.split("-");
  const formattedDate = parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : targetValidFromIso;

  const daysLabel = `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`;

  // - Amber (1 to 3 days remaining): "⚠️ Voucher Batch Expiring Soon: DD/MM/YYYY (X days left)"
  if (daysLeft <= 3) {
    return {
      type: "amber",
      icon: "⚠️",
      text: `Voucher Batch Expiring Soon: ${formattedDate} (${daysLabel})`,
      className: "text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800/60",
      targetValidFromIso,
      maxExpiryIso: batchExpiryIso,
      formattedDate,
      daysDiff: daysLeft
    };
  }

  // - Green (> 3 days remaining): "🟢 Codes Valid Until: DD/MM/YYYY (X days left)"
  return {
    type: "green",
    icon: "🟢",
    text: `Codes Valid Until: ${formattedDate} (${daysLabel})`,
    className: "text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800/60",
    targetValidFromIso,
    maxExpiryIso: batchExpiryIso,
    formattedDate,
    daysDiff: daysLeft
  };
}

export {
  validateVoucherCSV,
  type VoucherValidationError,
  type VoucherImportValidationResult
} from "./voucherCsvValidator";
