import * as XLSX from "xlsx";
import { safeLocalStorage } from "./safeLocalStorage";
import { isVrmSilentBlockedSync } from "../lib/blocklist";
import {
  cleanVoucherCodeValue,
  normalizeDateToISO,
  addDaysISO,
  getVoucherValidFromISO,
  getVoucherValidToISO,
  isVoucherForPermitDateRange
} from "./voucherValidation";

export {
  cleanVoucherCodeValue,
  normalizeDateToISO,
  addDaysISO,
  getVoucherValidFromISO,
  getVoucherValidToISO,
  isVoucherForPermitDateRange
};

export function findFormIdColumn(headers: string[]): number {
  const exactTargets = ["form id", "form_id", "formid", "id", "id_no", "id no", "response id", "submission id"];
  let idx = headers.findIndex(h => exactTargets.includes(h.toLowerCase().trim()));
  if (idx !== -1) return idx;

  idx = headers.findIndex(h => h.toLowerCase().includes("form id") || h.toLowerCase().includes("form_id") || h.toLowerCase().includes("formid"));
  if (idx !== -1) return idx;

  idx = headers.findIndex(h => h.toLowerCase() === "id" || h.toLowerCase() === "id_no" || h.toLowerCase() === "id no");
  if (idx !== -1) return idx;

  return -1;
}

export function findVoucherCodeColumn(headers: string[]): number {
  const exactTargets = [
    "vouchercode", "voucher_code", "voucher code", "code", "vouchers", "voucher",
    "qrcode", "qr_code", "qr code", "qr",
    "concessioncode", "concession_code", "concession code", "concession",
    "permitcode", "permit_code", "permit code"
  ];
  let idx = headers.findIndex(h => exactTargets.includes(h));
  if (idx !== -1) return idx;

  idx = headers.findIndex(h => 
    (h.includes("vouchercode") || h.includes("voucher_code") || h.includes("voucher code") || h.includes("voucher") || h.includes("concession") || h.includes("qr")) && 
    !h.includes("id")
  );
  if (idx !== -1) return idx;

  idx = headers.findIndex(h => 
    h.includes("code") && 
    !h.includes("id") && 
    h !== "categorycode" && 
    h !== "tariffcode"
  );
  if (idx !== -1) return idx;

  idx = headers.findIndex(h => 
    h.includes("voucher") && 
    !h.includes("id") && 
    h !== "vouchertype"
  );
  if (idx !== -1) return idx;

  idx = headers.findIndex(h => 
    (h.includes("code") || h.includes("voucher")) && 
    h !== "voucherid" && 
    h !== "voucher_id"
  );
  if (idx !== -1) return idx;

  return -1;
}

export function findValidFromColumn(headers: string[]): number {
  const exactTargets = [
    "validfrom", "valid_from", "valid from", "startdate", "start_date", "start date",
    "from", "start", "from date", "from_date", "valid from date", "effective date", "date required"
  ];
  let idx = headers.findIndex(h => exactTargets.includes(h));
  if (idx !== -1) return idx;

  idx = headers.findIndex(h => 
    h.includes("validfrom") || 
    h.includes("valid_from") || 
    h.includes("valid from") || 
    h.includes("start") || 
    h.includes("from")
  );
  if (idx !== -1) return idx;

  idx = headers.findIndex(h => 
    (h === "date" || h.includes("date") || h.includes("day")) && 
    !h.includes("to") && !h.includes("end") && !h.includes("expire") && !h.includes("expiry") && !h.includes("until")
  );
  if (idx !== -1) return idx;

  return -1;
}

export function findValidToColumn(headers: string[]): number {
  const exactTargets = [
    "validto", "valid_to", "valid to", "enddate", "end_date", "end date", 
    "expire", "expiry", "to", "until", "expiration", "validuntil", 
    "valid_until", "valid until", "expirydate", "expiry_date", "expiry date",
    "valid to date", "end date", "end_date", "end"
  ];
  let idx = headers.findIndex(h => exactTargets.includes(h));
  if (idx !== -1) return idx;

  idx = headers.findIndex(h => 
    h.includes("validto") || 
    h.includes("valid_to") || 
    h.includes("valid to") || 
    h.includes("validuntil") ||
    h.includes("valid_until") ||
    h.includes("valid until") ||
    h.includes("end") || 
    h.includes("expire") || 
    h.includes("expiry") ||
    h.includes("until") ||
    h === "to" ||
    h.endsWith(" to") ||
    h.startsWith("to ")
  );
  if (idx !== -1) return idx;

  return -1;
}

export function resolveDateExpiry(rawDate: string, rawExpiry: string): string {
  if (rawExpiry) {
    const s = String(rawExpiry).trim();
    const parsedExp = parseDateToISO(s);
    if (/^\d{4}-\d{2}-\d{2}$/.test(parsedExp)) {
      return s;
    }
  }
  if (rawDate) {
    const parsedStart = parseDateToISO(rawDate);
    if (/^\d{4}-\d{2}-\d{2}$/.test(parsedStart)) {
      const isoExpiry = addDays(parsedStart, 6);
      const parts = isoExpiry.split("-");
      if (parts.length === 3) {
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
      }
      return isoExpiry;
    }
  }
  return "";
}

export function formatDate(d?: any): string {
  try {
    if (d === undefined || d === null) return "";
    const s = String(d).trim();
    if (!s || s === "-" || s === "—" || s.toLowerCase() === "null" || s.toLowerCase() === "undefined") return "";
    const iso = parseDateToISO(s);
    if (!iso) return s;
    const parts = iso.split("-");
    return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : s;
  } catch (e) {
    return "";
  }
}

export function toTitleCase(str: string): string {
  if (!str || str === "-") return str;
  return str
    .toLowerCase()
    .replace(/(?:^|\s|-)\S/g, (char) => char.toUpperCase());
}

export function formatFormId(val: string | number | undefined | null): string {
  if (val === undefined || val === null || val === "") return "-";
  const str = String(val).trim();
  if (str === "" || str === "-") return "-";
  return str;
}

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

export interface CsvPermitRecord {
  id: string;
  formId?: string | number;
  hospital: string;
  ward: string;
  dateRequired: string;
  validFrom?: string;
  validTo?: string;
  dateExpiry?: string;
  vrm: string;
  driverName: string;
  name?: string;
  phone?: string;
  email?: string;
  driverEmail?: string;
  voucherCode?: string;
  prePaidCode?: string;
  qrCode?: string;
  serialNumber?: string;
  voucherCodesText?: string;
  voucher?: string;
  code?: string;
  startTime?: string;
  createdAt?: string;
  created_at?: string;
  completionTime?: string;
  hasOriginalVoucher?: boolean;
  isCancelled?: boolean;
  isDispatched?: boolean;
  dispatchedAt?: string;
  status?: string;
  todayDate?: string;
  processingDate?: string;
  submissionDate?: string;
  department?: string;
  title?: string;
  site?: string;
  qrOverride?: string;
  emailType?: "SEND_CONCESSION" | "RESEND_CONCESSION" | string;
  isResend?: boolean;
  emailTemplate?: "new" | "replacement";
  replacementCode?: string;
  originalVoucherCode?: string;
  replacementCount?: number;
  cancellationReason?: "DUPLICATE_VRM" | "BLOCKLIST" | "EXPIRED" | "MANUAL" | string;
}

export function getNumericFormId(record?: any): number {
  if (!record) return 0;
  try {
    const val = record?.formId !== undefined && record?.formId !== null && record?.formId !== "" ? record.formId : record?.id;
    if (typeof val === "number" && !isNaN(val)) return Math.floor(val);
    const formatted = formatFormId(val);
    if (!formatted || formatted === "-") return 0;
    const match = String(formatted).match(/\d+/);
    if (match) {
      const num = parseInt(match[0], 10);
      return isNaN(num) ? 0 : num;
    }
  } catch (e) {}
  return 0;
}

export function sortRecordsBySubmissionTimeDesc(records: CsvPermitRecord[]): CsvPermitRecord[] {
  if (!records || !Array.isArray(records)) return [];
  return [...records].sort((a, b) => {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    try {
      const timeA = extractRecordSubmissionTimeMs(a) || 0;
      const timeB = extractRecordSubmissionTimeMs(b) || 0;
      if (timeA > 0 && timeB > 0 && timeA !== timeB) {
        return timeB - timeA;
      }
      if (timeA > 0 && (!timeB || timeB === 0)) return -1;
      if (timeB > 0 && (!timeA || timeA === 0)) return 1;

      const dateA = parseDateToISO(a?.dateRequired || a?.validFrom || "") || "";
      const dateB = parseDateToISO(b?.dateRequired || b?.validFrom || "") || "";
      if (dateA && dateB && dateA !== dateB) {
        return dateB.localeCompare(dateA);
      }

      return (getNumericFormId(b) || 0) - (getNumericFormId(a) || 0);
    } catch (e) {
      return 0;
    }
  });
}

export function sortRecordsByFormIdDesc(records: CsvPermitRecord[]): CsvPermitRecord[] {
  if (!records || !Array.isArray(records)) return [];
  return [...records].sort((a, b) => {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    try {
      const idA = getNumericFormId(a) || 0;
      const idB = getNumericFormId(b) || 0;
      if (idA !== idB) {
        return idB - idA;
      }

      const timeA = extractRecordSubmissionTimeMs(a) || 0;
      const timeB = extractRecordSubmissionTimeMs(b) || 0;
      if (timeA > 0 && timeB > 0 && timeA !== timeB) {
        return timeB - timeA;
      }
      if (timeA > 0 && (!timeB || timeB === 0)) return -1;
      if (timeB > 0 && (!timeA || timeA === 0)) return 1;

      const dateA = parseDateToISO(a?.dateRequired || a?.validFrom || "") || "";
      const dateB = parseDateToISO(b?.dateRequired || b?.validFrom || "") || "";
      if (dateA && dateB && dateA !== dateB) {
        return dateB.localeCompare(dateA);
      }

      return 0;
    } catch (e) {
      return 0;
    }
  });
}

export function sortRecordsByFormIdAsc(records: CsvPermitRecord[]): CsvPermitRecord[] {
  if (!records || !Array.isArray(records)) return [];
  return [...records].sort((a, b) => {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return (getNumericFormId(a) || 0) - (getNumericFormId(b) || 0);
  });
}

export function getMaxFormId(records: CsvPermitRecord[]): number {
  let max = 0;
  for (const r of records) {
    const num = getNumericFormId(r);
    if (num > max) max = num;
  }
  return max;
}

export function generateNextFormId(records: CsvPermitRecord[]): string {
  const nextNum = getMaxFormId(records) + 1;
  return String(nextNum).padStart(5, "0");
}

export function formatExportStartTime(dateRequired?: string, startTime?: string, completionTime?: string): string {
  const targetRaw = completionTime || startTime || dateRequired || "";
  if (!targetRaw) return "-";

  let datePart = targetRaw.trim();
  if (datePart.includes(" - ")) {
    datePart = datePart.split(" - ")[0].trim();
  } else if (datePart.includes(" to ")) {
    datePart = datePart.split(" to ")[0].trim();
  }

  const iso = parseDateToISO(datePart);
  if (iso) {
    const parts = iso.split("-");
    if (parts.length === 3) {
      const formattedDate = `${parts[2]}/${parts[1]}/${parts[0]}`;
      const timeMatch = datePart.match(/(?:\s+|T)(\d{1,2}:\d{2}(?::\d{2})?)/);
      if (timeMatch) {
        return `${formattedDate} ${timeMatch[1]}`;
      }
      return formattedDate;
    }
  }

  return datePart || "-";
}

export function formatExportCreatedAt(createdAt?: string, created_at?: string, startTime?: string): string {
  if (createdAt && createdAt.trim()) return createdAt.trim();
  if (created_at && created_at.trim()) return created_at.trim();
  if (startTime && startTime.trim()) return startTime.trim();
  return "-";
}

export function formatSubmittedDateTime(record?: any): string {
  if (!record) return "-";

  try {
    const candidate = 
      (record?.completionTime && String(record.completionTime).trim() && String(record.completionTime).trim() !== "-")
        ? String(record.completionTime).trim()
        : ((record as any)?.completion_time && String((record as any).completion_time).trim() && String((record as any).completion_time).trim() !== "-")
          ? String((record as any).completion_time).trim()
          : (record?.startTime && String(record.startTime).trim() && String(record.startTime).trim() !== "-")
            ? String(record.startTime).trim()
            : ((record as any)?.start_time && String((record as any).start_time).trim() && String((record as any).start_time).trim() !== "-")
              ? String((record as any).start_time).trim()
              : (record?.createdAt && String(record.createdAt).trim() && String(record.createdAt).trim() !== "-")
                ? String(record.createdAt).trim()
                : ((record as any)?.created_at && String((record as any).created_at).trim() && String((record as any).created_at).trim() !== "-")
                  ? String((record as any).created_at).trim()
                  : "";

    const effectiveStr = String(candidate || "").trim();

    if (!effectiveStr || effectiveStr === "-" || effectiveStr.toLowerCase() === "null" || effectiveStr.toLowerCase() === "undefined") {
      return "-";
    }

    const ukMatch = effectiveStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AP]M))?)?/i);
    if (ukMatch) {
      let day = parseInt(ukMatch[1], 10);
      let month = parseInt(ukMatch[2], 10);
      let yearStr = ukMatch[3];
      if (yearStr.length === 2) {
        const yy = parseInt(yearStr, 10);
        yearStr = (yy >= 70 ? "19" : "20") + yearStr;
      }
      const year = parseInt(yearStr, 10);
      let hours = ukMatch[4] ? parseInt(ukMatch[4], 10) : 0;
      const minutes = ukMatch[5] ? parseInt(ukMatch[5], 10) : 0;
      const seconds = ukMatch[6] ? parseInt(ukMatch[6], 10) : 0;
      const ampm = ukMatch[7];

      if (ampm) {
        if (/PM/i.test(ampm) && hours < 12) hours += 12;
        if (/AM/i.test(ampm) && hours === 12) hours = 0;
      }

      if (month > 12 && day <= 12) {
        const temp = day;
        day = month;
        month = temp;
      }

      const dd = String(day).padStart(2, "0");
      const mm = String(month).padStart(2, "0");
      const yyyy = String(year).padStart(4, "0");
      const hh = String(hours).padStart(2, "0");
      const min = String(minutes).padStart(2, "0");
      const ss = String(seconds).padStart(2, "0");

      return `${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`;
    }

    const isoMatch = effectiveStr.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AP]M))?)?/i);
    if (isoMatch) {
      const year = parseInt(isoMatch[1], 10);
      const month = parseInt(isoMatch[2], 10);
      const day = parseInt(isoMatch[3], 10);
      let hours = isoMatch[4] ? parseInt(isoMatch[4], 10) : 0;
      const minutes = isoMatch[5] ? parseInt(isoMatch[5], 10) : 0;
      const seconds = isoMatch[6] ? parseInt(isoMatch[6], 10) : 0;
      const ampm = isoMatch[7];

      if (ampm) {
        if (/PM/i.test(ampm) && hours < 12) hours += 12;
        if (/AM/i.test(ampm) && hours === 12) hours = 0;
      }

      const dd = String(day).padStart(2, "0");
      const mm = String(month).padStart(2, "0");
      const yyyy = String(year).padStart(4, "0");
      const hh = String(hours).padStart(2, "0");
      const min = String(minutes).padStart(2, "0");
      const ss = String(seconds).padStart(2, "0");

      return `${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`;
    }

    const d = new Date(effectiveStr);
    if (!isNaN(d.getTime()) && d.getTime() > 0) {
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const yyyy = d.getFullYear();
      const hh = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      const ss = String(d.getSeconds()).padStart(2, "0");
      return `${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`;
    }

    return effectiveStr;
  } catch (e) {
    return "-";
  }
}

export function getRecordSubmittedTimeMs(record?: any): number {
  if (!record) return 0;
  try {
    const candidate = 
      (record?.completionTime && String(record.completionTime).trim() && String(record.completionTime).trim() !== "-")
        ? String(record.completionTime).trim()
        : ((record as any)?.completion_time && String((record as any).completion_time).trim() && String((record as any).completion_time).trim() !== "-")
          ? String((record as any).completion_time).trim()
          : (record?.startTime && String(record.startTime).trim() && String(record.startTime).trim() !== "-")
            ? String(record.startTime).trim()
            : ((record as any)?.start_time && String((record as any).start_time).trim() && String((record as any).start_time).trim() !== "-")
              ? String((record as any).start_time).trim()
              : (record?.createdAt && String(record.createdAt).trim() && String(record.createdAt).trim() !== "-")
                ? String(record.createdAt).trim()
                : ((record as any)?.created_at && String((record as any).created_at).trim() && String((record as any).created_at).trim() !== "-")
                  ? String((record as any).created_at).trim()
                  : "";
    if (!candidate || candidate === "-" || candidate.toLowerCase() === "null" || candidate.toLowerCase() === "undefined") return 0;

    const recDateISO = parseDateToISO(record?.dateRequired || record?.validFrom || record?.todayDate || "") || "";
    const ms = parseFullDateTimeMs(String(candidate), recDateISO);
    if (ms !== null && ms > 0) return ms;

    const directTs = safeParseDateToTimestamp(candidate);
    if (directTs !== null && directTs > 0) return directTs;

    return 0;
  } catch (e) {
    return 0;
  }
}

export function getRecordSubmittedDateISO(record?: any): string {
  if (!record) return "";
  const ms = getRecordSubmittedTimeMs(record);
  if (!ms || ms <= 0) return "";
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function exportToExcel(
  records: CsvPermitRecord[], 
  filename = "Concessions_Permits_Export.xlsx", 
  customVouchersMap?: Record<string, string>,
  processingDate?: string
) {
  const seenIds = new Set<string>();
  const uniqueRecords: CsvPermitRecord[] = [];

  for (const r of records) {
    const rawId = (r.formId !== undefined && r.formId !== null && r.formId !== "" ? r.formId : r.id) || "";
    const cleanId = formatFormId(rawId);
    const key = (cleanId && cleanId !== "-") ? cleanId : String(r.id || "");

    if (key && seenIds.has(key)) {
      continue;
    }
    if (key) {
      seenIds.add(key);
    }
    uniqueRecords.push(r);
  }

  const sorted = sortRecordsByFormIdDesc(uniqueRecords);

  const rows = sorted.map(r => {
    let voucherVal = r.voucherCode || r.prePaidCode || r.qrCode || r.serialNumber;
    if ((!voucherVal || voucherVal === "-" || voucherVal.trim() === "") && customVouchersMap) {
      const cleanVrm = r.vrm ? r.vrm.toUpperCase().replace(/\s+/g, "") : "";
      const recDateISO = parseDateToISO(r.dateRequired || "") || "";
      const keyWithDate = recDateISO ? `${cleanVrm}_${recDateISO}` : cleanVrm;
      const hasStableId = Boolean(
        (r.formId !== undefined && r.formId !== null && String(r.formId).trim() !== "") ||
        (r.id !== undefined && r.id !== null && String(r.id).trim() !== "")
      );
      const customCode = (r.formId ? customVouchersMap[String(r.formId)] : undefined) ||
                         (r.id ? customVouchersMap[r.id] : undefined) ||
                         (!hasStableId && cleanVrm && !isPlaceholderVrm(cleanVrm)
                           ? (customVouchersMap[keyWithDate] || customVouchersMap[cleanVrm])
                           : undefined);
      if (customCode) {
        voucherVal = customCode;
      }
    }

    const finalVoucherCode = (voucherVal && voucherVal.trim() !== "") ? voucherVal.trim() : "-";
    const cleanFormId = formatFormId(r.formId !== undefined && r.formId !== null && r.formId !== "" ? r.formId : r.id);

    return {
      "Form ID": cleanFormId,
      "Hospital": r.hospital || "-",
      "Ward / Department": r.ward || "-",
      "Date Required": r.dateRequired || "-",
      "Date Expiry": r.dateExpiry || "-",
      "VRM": r.vrm || "-",
      "Driver Name": r.driverName || "-",
      "Driver Phone": r.phone || "-",
      "Driver Email": r.email || "-",
      "Voucher Code": finalVoucherCode,
      "Start Time": formatExportStartTime(r.dateRequired, r.startTime, r.completionTime),
      "Created At": formatExportCreatedAt(r.createdAt, r.created_at, r.startTime)
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(rows, {
    header: [
      "Form ID",
      "Hospital",
      "Ward / Department",
      "Date Required",
      "Date Expiry",
      "VRM",
      "Driver Name",
      "Driver Phone",
      "Driver Email",
      "Voucher Code",
      "Start Time",
      "Created At"
    ]
  });

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Permits");
  XLSX.writeFile(workbook, filename);
}

export function exportToCSV(
  records: CsvPermitRecord[], 
  filename = "Concessions_Permits_Export.csv", 
  customVouchersMap?: Record<string, string>,
  processingDate?: string
) {
  const seenIds = new Set<string>();
  const uniqueRecords: CsvPermitRecord[] = [];

  for (const r of records) {
    const rawId = (r.formId !== undefined && r.formId !== null && r.formId !== "" ? r.formId : r.id) || "";
    const cleanId = formatFormId(rawId);
    const key = (cleanId && cleanId !== "-") ? cleanId : String(r.id || "");

    if (key && seenIds.has(key)) {
      continue;
    }
    if (key) {
      seenIds.add(key);
    }
    uniqueRecords.push(r);
  }

  const sorted = sortRecordsByFormIdDesc(uniqueRecords);

  const headers = [
    "Form ID",
    "Hospital",
    "Ward / Department",
    "Date Required",
    "Date Expiry",
    "VRM",
    "Driver Name",
    "Driver Phone",
    "Driver Email",
    "Voucher Code",
    "Start Time",
    "Created At"
  ];

  const escapeCsvField = (field: any) => {
    if (field === undefined || field === null) return '""';
    const str = String(field).replace(/"/g, '""');
    return `"${str}"`;
  };

  const csvRows = [headers.join(",")];

  for (const r of sorted) {
    let voucherVal = r.voucherCode || r.prePaidCode || r.qrCode || r.serialNumber;
    if ((!voucherVal || voucherVal === "-" || voucherVal.trim() === "") && customVouchersMap) {
      const cleanVrm = r.vrm ? r.vrm.toUpperCase().replace(/\s+/g, "") : "";
      const recDateISO = parseDateToISO(r.dateRequired || "") || "";
      const keyWithDate = recDateISO ? `${cleanVrm}_${recDateISO}` : cleanVrm;
      const hasStableId = Boolean(
        (r.formId !== undefined && r.formId !== null && String(r.formId).trim() !== "") ||
        (r.id !== undefined && r.id !== null && String(r.id).trim() !== "")
      );
      const customCode = (r.formId ? customVouchersMap[String(r.formId)] : undefined) ||
                         (r.id ? customVouchersMap[r.id] : undefined) ||
                         (!hasStableId && cleanVrm && !isPlaceholderVrm(cleanVrm)
                           ? (customVouchersMap[keyWithDate] || customVouchersMap[cleanVrm])
                           : undefined);
      if (customCode) {
        voucherVal = customCode;
      }
    }

    const finalVoucherCode = (voucherVal && voucherVal.trim() !== "") ? voucherVal.trim() : "-";
    const cleanFormId = formatFormId(r.formId !== undefined && r.formId !== null && r.formId !== "" ? r.formId : r.id);

    const row = [
      escapeCsvField(cleanFormId),
      escapeCsvField(r.hospital || "-"),
      escapeCsvField(r.ward || "-"),
      escapeCsvField(r.dateRequired || "-"),
      escapeCsvField(r.dateExpiry || "-"),
      escapeCsvField(r.vrm || "-"),
      escapeCsvField(r.driverName || "-"),
      escapeCsvField(r.phone || "-"),
      escapeCsvField(r.email || "-"),
      escapeCsvField(finalVoucherCode),
      escapeCsvField(formatExportStartTime(r.dateRequired, r.startTime, r.completionTime)),
      escapeCsvField(formatExportCreatedAt(r.createdAt, r.created_at, r.startTime))
    ];
    csvRows.push(row.join(","));
  }

  const csvString = csvRows.join("\r\n");
  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function parsePastedText(rawText: string): CsvPermitRecord[] {
  if (!rawText || !rawText.trim()) return [];

  const detectedFormat = detectDateFormat(rawText);
  safeLocalStorage.setItem("concessions_date_format_resolved", detectedFormat);

  const lines = rawText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const splitLine = (l: string): string[] => {
    if (l.includes("\t")) {
      return l.split("\t").map(c => c.trim());
    }
    const csvParsed = splitCsvLine(l).map(c => c.trim());
    if (csvParsed.length >= 4) return csvParsed;
    return l.split(/\s{2,}/).map(c => c.trim());
  };

  const firstLine = lines[0];
  const firstLineCols = splitLine(firstLine);
  
  const firstCell = firstLineCols[0] || "";
  const dateRegex = /^\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}/;
  const isFirstCellDate = dateRegex.test(firstCell);

  const lowerFirstLine = firstLine.toLowerCase();
  const hasHeaders = !isFirstCellDate && (
    lowerFirstLine.includes("driver") || 
    lowerFirstLine.includes("vrm") || 
    lowerFirstLine.includes("plate") || 
    lowerFirstLine.includes("valid") || 
    lowerFirstLine.includes("permit") ||
    lowerFirstLine.includes("hospital") ||
    lowerFirstLine.includes("ward") ||
    lowerFirstLine.includes("department") ||
    lowerFirstLine.includes("required") ||
    lowerFirstLine.includes("email") ||
    lowerFirstLine.includes("start time") ||
    lowerFirstLine.includes("completion time")
  );

  const records: CsvPermitRecord[] = [];

  if (hasHeaders) {
    const headers = firstLineCols.map(h => h.toLowerCase().trim());

    const hospitalIdx = headers.findIndex(h => h.includes("hospital") || h.includes("based in") || h.includes("site"));
    const wardIdx = headers.findIndex(h => h.includes("ward") || h.includes("department") || h.includes("dept"));
    
    let dateIdx = headers.findIndex(h => h.includes("date the parking is required on") || h.includes("parking required") || h.includes("date required") || h.includes("valid from") || h.includes("valid_from"));
    if (dateIdx === -1 && headers.length > 8) {
      const colIHeader = headers[8];
      if (colIHeader.includes("date") || colIHeader.includes("required") || colIHeader.includes("parking") || colIHeader.includes("valid")) {
        dateIdx = 8;
      }
    }
    if (dateIdx === -1) {
      dateIdx = headers.findIndex(h => h.includes("date") && (h.includes("required") || h.includes("parking") || h.includes("start")));
    }

    const vrmIdx = headers.findIndex(h => h.includes("registration") || h.includes("plate") || h.includes("vrm"));
    const phoneIdx = headers.findIndex(h => h.includes("phone") || h.includes("mobile") || h.includes("contact") || h.includes("tel"));
    
    let startTimeIdx = headers.findIndex(h => h === "start time" || h === "start_time" || h.includes("submission start") || h.includes("submission time"));
    if (startTimeIdx === -1 && headers.length > 1) {
      const colBHeader = headers[1];
      if (colBHeader.includes("start") || colBHeader.includes("time") || colBHeader.includes("submit") || colBHeader.includes("creation")) {
        startTimeIdx = 1;
      }
    }
    if (startTimeIdx === -1 && headers.length >= 10) {
      startTimeIdx = 1;
    }

    let completionTimeIdx = headers.findIndex(h => 
      h === "completion time" || 
      h === "completion_time" || 
      h === "completiontime" ||
      h === "end time" ||
      h === "end_time" ||
      h === "endtime" ||
      h === "finish time" ||
      h === "finish_time" ||
      h === "date submitted" ||
      h === "submitted date" ||
      h.includes("completion time") || 
      h.includes("completed time") || 
      h.includes("submission end") ||
      h.includes("time completed") ||
      h.includes("completed at") ||
      h.includes("completion")
    );
    if (completionTimeIdx === -1 && headers.length > 2) {
      const colCHeader = headers[2];
      if (colCHeader.includes("completion") || colCHeader.includes("complete") || (startTimeIdx === 1 && colCHeader.includes("time"))) {
        completionTimeIdx = 2;
      }
    }
    
    let driverIdx = -1;
    if (headers.length > 11) {
      driverIdx = 11;
    } else {
      driverIdx = headers.findIndex(h => h.includes("driver") || h.includes("holder") || h.includes("full name"));
      if (driverIdx === -1) {
        driverIdx = headers.findIndex(h => h === "name");
      }
    }

    let emailIdx = -1;
    if (headers.length > 13) {
      emailIdx = 13;
    } else {
      emailIdx = headers.findIndex(h => h.includes("email") || h.includes("mail"));
    }

    const voucherIdx = findVoucherCodeColumn(headers);
    const validToIdx = findValidToColumn(headers);
    const idIdx = findFormIdColumn(headers);

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const columns = splitLine(line);

      if (columns.length < 2) continue;

      const rawVrm = vrmIdx !== -1 ? columns[vrmIdx] : "";
      const rawDriver = driverIdx !== -1 ? columns[driverIdx] : "";
      const rawHospital = hospitalIdx !== -1 ? columns[hospitalIdx] : "";
      const rawWard = wardIdx !== -1 ? columns[wardIdx] : "";
      const rawDate = dateIdx !== -1 ? columns[dateIdx] : "";
      const rawPhone = phoneIdx !== -1 ? columns[phoneIdx] : "";
      const rawEmail = emailIdx !== -1 ? columns[emailIdx] : "";
      const rawVoucher = voucherIdx !== -1 ? columns[voucherIdx] : "";
      const rawExpiry = validToIdx !== -1 ? columns[validToIdx] : "";
      const rawStartTime = startTimeIdx !== -1 ? columns[startTimeIdx] : "";
      const rawCompletionTime = completionTimeIdx !== -1 ? columns[completionTimeIdx] : "";

      const cleanVrm = rawVrm ? rawVrm.toUpperCase().replace(/\s+/g, "") : "";
      if (!cleanVrm && !rawDriver && !rawEmail) continue;

      let formIdStr = "";
      if (idIdx !== -1 && columns[idIdx]) {
        const rawIdVal = String(columns[idIdx]).trim();
        const cleaned = formatFormId(rawIdVal);
        if (cleaned && cleaned !== "-") {
          formIdStr = cleaned;
        }
      }
      if (!formIdStr) {
        formIdStr = String(i);
      }

      const parsedReqDate = parseUKDate(rawDate) || rawDate;
      const parsedExpDate = parseUKDate(rawExpiry) || rawExpiry;

      records.push({
        id: formIdStr,
        formId: formIdStr,
        hospital: rawHospital || "Whipps Cross Hospital",
        ward: rawWard || "Acorn Ward",
        dateRequired: parsedReqDate,
        dateExpiry: resolveDateExpiry(parsedReqDate, parsedExpDate),
        vrm: cleanVrm || "PENDING",
        driverName: rawDriver || "Driver's Name",
        phone: rawPhone ? formatPhoneNumber(String(rawPhone)) : "",
        email: rawEmail ? String(rawEmail).trim() : "",
        voucherCode: cleanVoucherCodeValue(rawVoucher),
        startTime: rawStartTime || undefined,
        completionTime: rawCompletionTime || undefined,
        createdAt: rawStartTime || undefined
      });
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const columns = splitLine(line);

      if (columns.length < 2) continue;

      const hasStandardConcessionsCols = (
        columns.length >= 7 &&
        (columns[0].startsWith("#") || /^\d+$/.test(columns[0])) &&
        (columns[1].toLowerCase().includes("hospital") || columns[1].toLowerCase().includes("site") || columns[1].toLowerCase().includes("whipps") || columns[1].toLowerCase().includes("newham") || columns[1].toLowerCase().includes("barts") || columns[1].toLowerCase().includes("royal"))
      );

      if (hasStandardConcessionsCols) {
        const rawId = columns[0] || "";
        const rawHospital = columns[1] || "Newham Hospital";
        const rawWard = columns[2] || "ICU";
        const rawDate = columns[3] || "";
        const rawExpiry = columns[4] || "";
        const rawVrm = columns[5] || "";
        const rawDriver = columns[6] || "Driver's Name";
        const rawPhone = columns[7] || "";
        const rawEmail = columns[8] || "";
        const rawVoucher = columns[9] || "";
        const rawStartTime = columns[10] || "";
        const rawCompletionTime = columns[11] || "";

        const formIdStr = formatFormId(rawId) || String(i + 1);
        const cleanVrm = rawVrm ? rawVrm.toUpperCase().replace(/\s+/g, "") : "";

        records.push({
          id: formIdStr,
          formId: formIdStr,
          hospital: rawHospital,
          ward: rawWard,
          dateRequired: rawDate,
          dateExpiry: resolveDateExpiry(rawDate, rawExpiry),
          vrm: cleanVrm || "PENDING",
          driverName: rawDriver,
          phone: rawPhone ? formatPhoneNumber(rawPhone) : "",
          email: rawEmail,
          voucherCode: cleanVoucherCodeValue(rawVoucher),
          startTime: rawStartTime || undefined,
          completionTime: rawCompletionTime || undefined,
          createdAt: rawStartTime || undefined
        });
        continue;
      }

      let isMsFormsFormat = false;
      let formsEmailIdx = -1;
      let formsHospitalIdx = -1;

      if (columns.length >= 7) {
        formsEmailIdx = columns.findIndex(c => c && c.includes("@"));
        formsHospitalIdx = columns.findIndex(c => {
          const lower = c.toLowerCase();
          return lower.includes("hospital") || lower.includes("whipps") || lower.includes("newham") || lower.includes("barts") || lower.includes("royal") || lower.includes("mile");
        });

        if (formsEmailIdx !== -1 && formsHospitalIdx !== -1) {
          isMsFormsFormat = true;
        } else if (formsHospitalIdx !== -1 && (formsHospitalIdx === 2 || formsHospitalIdx === 3)) {
          isMsFormsFormat = true;
        }
      }

      let rawDriver = "Driver's Name";
      let rawVrm = "";
      let rawVoucher = "";
      let rawWard = "Acorn Ward";
      let rawDate = "";
      let rawExpiry = "";
      let rawHospital = "Newham Hospital";
      let rawEmail = "";
      let rawPhone = "";
      let rawStartTime = "";
      let rawCompletionTime = "";

      if (isMsFormsFormat) {
        rawStartTime = columns[0] || "";
        if (columns[1] && (columns[1].includes(":") || columns[1].includes("/"))) {
          rawCompletionTime = columns[1];
        }
        rawEmail = formsEmailIdx !== -1 ? (columns[formsEmailIdx] || "") : "";
        rawHospital = columns[formsHospitalIdx] || "Newham Hospital";
        rawWard = columns[formsHospitalIdx + 1] || "Acorn Ward";
        rawDate = columns[formsHospitalIdx + 2] || "";
        
        if (formsEmailIdx !== -1 && formsEmailIdx + 1 < columns.length) {
          rawDriver = columns[formsEmailIdx + 1] || "Driver's Name";
        } else {
          if (formsHospitalIdx + 4 < columns.length) {
            rawDriver = columns[formsHospitalIdx + 4];
          } else {
            rawDriver = columns[columns.length - 1] || "Driver's Name";
          }
        }

        if (formsHospitalIdx + 3 < columns.length) {
          rawVrm = columns[formsHospitalIdx + 3];
        } else {
          rawVrm = "PENDING";
        }
      } else {
        rawDriver = columns[0] || "Driver's Name";
        rawVrm = columns[1] || "";
        rawVoucher = columns[2] || "";
        rawWard = columns[3] || "Acorn Ward";
        rawDate = columns[4] || "";
        rawExpiry = columns[5] || "";
      }

      const cleanVrm = rawVrm ? rawVrm.toUpperCase().replace(/\s+/g, "") : "";
      if (!cleanVrm && !rawDriver && !rawEmail) continue;

      const seqFormId = String(i + 1);

      records.push({
        id: seqFormId,
        formId: seqFormId,
        hospital: rawHospital,
        ward: rawWard,
        dateRequired: rawDate,
        dateExpiry: resolveDateExpiry(rawDate, rawExpiry),
        vrm: cleanVrm || "PENDING",
        driverName: rawDriver,
        phone: rawPhone ? formatPhoneNumber(rawPhone) : "",
        email: rawEmail,
        voucherCode: cleanVoucherCodeValue(rawVoucher),
        startTime: rawStartTime || undefined,
        completionTime: rawCompletionTime || undefined,
        createdAt: rawStartTime || undefined
      });
    }
  }

  return sortRecordsByFormIdDesc(records);
}

export function parsePermitCsv(rawText: string): CsvPermitRecord[] {
  if (!rawText || !rawText.trim()) return [];

  const detectedFormat = detectDateFormat(rawText);
  safeLocalStorage.setItem("concessions_date_format_resolved", detectedFormat);

  const lines = rawText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  let headerRowIndex = 0;
  for (let r = 0; r < Math.min(5, lines.length); r++) {
    const l = lines[r].toLowerCase();
    if (l.includes("vrm") || l.includes("registration") || l.includes("plate") || l.includes("driver") || l.includes("email") || l.includes("hospital") || l.includes("ward") || l.includes("required")) {
      headerRowIndex = r;
      break;
    }
  }

  const firstLine = lines[headerRowIndex];
  const headers = (firstLine.includes("\t") 
    ? firstLine.split("\t").map(c => c.trim()) 
    : splitCsvLine(firstLine).map(c => c.trim())
  ).map(h => h.toLowerCase().trim());

  const idIdx = headers.findIndex(h => h === "id" || h === "form id" || h === "form_id" || h === "id_no" || h === "response id" || h === "record id");
  const hospitalIdx = headers.findIndex(h => h.includes("hospital") || h.includes("based in") || h.includes("site"));
  const wardIdx = headers.findIndex(h => h.includes("ward") || h.includes("department") || h.includes("dept"));
  
  let dateIdx = headers.findIndex(h => h.includes("date the parking is required on") || h.includes("parking required") || h.includes("date required") || h.includes("valid from") || h.includes("valid_from"));
  if (dateIdx === -1 && headers.length > 8) {
    const colIHeader = headers[8];
    if (colIHeader.includes("date") || colIHeader.includes("required") || colIHeader.includes("parking") || colIHeader.includes("valid")) {
      dateIdx = 8;
    }
  }
  if (dateIdx === -1) {
    dateIdx = headers.findIndex(h => h.includes("date") && (h.includes("required") || h.includes("parking") || h.includes("start")));
  }

  const vrmIdx = headers.findIndex(h => h.includes("registration") || h.includes("plate") || h.includes("vrm"));
  const phoneIdx = headers.findIndex(h => h.includes("phone") || h.includes("mobile") || h.includes("contact") || h.includes("tel"));
  
  let startTimeIdx = headers.findIndex(h => h === "start time" || h === "start_time" || h.includes("submission start") || h.includes("submission time"));
  if (startTimeIdx === -1 && headers.length > 1) {
    const colBHeader = headers[1];
    if (colBHeader.includes("start") || colBHeader.includes("time") || colBHeader.includes("submit") || colBHeader.includes("creation")) {
      startTimeIdx = 1;
    }
  }
  if (startTimeIdx === -1 && headers.length >= 10) {
    startTimeIdx = 1;
  }

  let completionTimeIdx = headers.findIndex(h => 
    h === "completion time" || 
    h === "completion_time" || 
    h === "completiontime" ||
    h === "end time" ||
    h === "end_time" ||
    h === "endtime" ||
    h === "finish time" ||
    h === "finish_time" ||
    h === "date submitted" ||
    h === "submitted date" ||
    h.includes("completion time") || 
    h.includes("completed time") || 
    h.includes("submission end") ||
    h.includes("time completed") ||
    h.includes("completed at") ||
    h.includes("completion")
  );
  if (completionTimeIdx === -1 && headers.length > 2) {
    const colCHeader = headers[2];
    if (colCHeader.includes("completion") || colCHeader.includes("complete") || (startTimeIdx === 1 && colCHeader.includes("time"))) {
      completionTimeIdx = 2;
    }
  }
  
  let driverIdx = -1;
  if (headers.length > 11) {
    driverIdx = 11;
  } else {
    driverIdx = headers.findIndex(h => h.includes("driver") || h.includes("holder") || h.includes("full name"));
    if (driverIdx === -1) {
      driverIdx = headers.findIndex(h => h === "name");
    }
  }

  let emailIdx = -1;
  if (headers.length > 13) {
    emailIdx = 13;
  } else {
    emailIdx = headers.findIndex(h => h.includes("email") || h.includes("mail"));
  }

  const voucherIdx = findVoucherCodeColumn(headers);
  const validToIdx = findValidToColumn(headers);

  const records: CsvPermitRecord[] = [];

  for (let i = headerRowIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const columns = line.includes("\t") 
      ? line.split("\t").map(c => c.trim()) 
      : splitCsvLine(line).map(c => c.trim());
    if (columns.length < 2) continue;

    const rawVrm = vrmIdx !== -1 ? columns[vrmIdx] : "";
    const rawDriver = driverIdx !== -1 ? columns[driverIdx] : "";
    const rawHospital = hospitalIdx !== -1 ? columns[hospitalIdx] : "";
    const rawWard = wardIdx !== -1 ? columns[wardIdx] : "";
    const rawDate = dateIdx !== -1 ? columns[dateIdx] : "";
    const rawPhone = phoneIdx !== -1 ? columns[phoneIdx] : "";
    const rawEmail = emailIdx !== -1 ? columns[emailIdx] : "";
    const rawVoucher = voucherIdx !== -1 ? columns[voucherIdx] : "";
    const rawExpiry = validToIdx !== -1 ? columns[validToIdx] : "";
    const rawStartTime = startTimeIdx !== -1 ? columns[startTimeIdx] : "";
    const rawCompletionTime = completionTimeIdx !== -1 ? columns[completionTimeIdx] : "";

    let cleanVrm = rawVrm ? String(rawVrm).trim().toUpperCase().replace(/\s+/g, "") : "";
    let cleanDriver = rawDriver ? String(rawDriver).trim() : "";
    let cleanEmail = rawEmail ? String(rawEmail).trim() : "";
    let cleanPhone = rawPhone ? String(rawPhone).trim() : "";
    let cleanHospital = rawHospital ? String(rawHospital).trim() : "";
    let cleanWard = rawWard ? String(rawWard).trim() : "";

    if (cleanVrm === "NULL" || cleanVrm === "UNDEFINED" || cleanVrm === "NONE" || cleanVrm === "N/A" || cleanVrm === "-") cleanVrm = "";
    if (cleanDriver.toLowerCase() === "null" || cleanDriver.toLowerCase() === "undefined") cleanDriver = "";
    if (cleanEmail.toLowerCase() === "null" || cleanEmail.toLowerCase() === "undefined") cleanEmail = "";

    const lowerDriver = cleanDriver.toLowerCase();
    if (
      lowerDriver === "driver's name" || lowerDriver === "driver name" ||
      lowerDriver === "driver" || lowerDriver === "name" ||
      lowerDriver === "full name" || lowerDriver.startsWith("total") ||
      lowerDriver.startsWith("subtotal") || lowerDriver === "id"
    ) {
      continue;
    }

    if (!cleanVrm && !cleanDriver && !cleanEmail && !rawDate && !rawStartTime) continue;

    let formIdStr = "";
    if (idIdx !== -1 && columns[idIdx]) {
      const rawIdVal = String(columns[idIdx]).trim();
      const cleaned = formatFormId(rawIdVal);
      if (cleaned && cleaned !== "-") {
        formIdStr = cleaned;
      }
    }
    if (!formIdStr) {
      formIdStr = `row-${i + 1}`;
    }

    records.push({
      id: formIdStr,
      formId: formIdStr,
      hospital: cleanHospital || "Whipps Cross Hospital",
      ward: cleanWard || "Acorn Ward",
      dateRequired: rawDate,
      dateExpiry: resolveDateExpiry(rawDate, rawExpiry),
      vrm: cleanVrm || "PENDING",
      driverName: cleanDriver || "Driver's Name",
      phone: cleanPhone ? formatPhoneNumber(cleanPhone) : "",
      email: cleanEmail,
      voucherCode: cleanVoucherCodeValue(rawVoucher),
      startTime: rawStartTime ? String(rawStartTime).trim() : undefined,
      completionTime: rawCompletionTime ? String(rawCompletionTime).trim() : undefined,
      createdAt: rawStartTime ? String(rawStartTime).trim() : undefined
    });
  }

  return sortRecordsByFormIdDesc(records);
}

export function parsePermitExcel(arrayBuffer: ArrayBuffer): CsvPermitRecord[] {
  try {
    const workbook = XLSX.read(arrayBuffer, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) return [];
    
    const worksheet = workbook.Sheets[firstSheetName];
    const rawRows = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1 });
    if (rawRows.length < 2) return [];

    try {
      const allCellsStr = rawRows.map(row => Array.isArray(row) ? row.join(" ") : "").join("\n");
      const detected = detectDateFormat(allCellsStr);
      safeLocalStorage.setItem("concessions_date_format_resolved", detected);
    } catch (e) {}

    let headerRowIndex = 0;
    for (let r = 0; r < Math.min(5, rawRows.length); r++) {
      const candidateRow = rawRows[r] as unknown[];
      if (candidateRow && Array.isArray(candidateRow)) {
        const candidateStr = candidateRow.map(c => String(c || "").toLowerCase()).join(" ");
        if (
          candidateStr.includes("vrm") || candidateStr.includes("registration") ||
          candidateStr.includes("plate") || candidateStr.includes("driver") ||
          candidateStr.includes("email") || candidateStr.includes("hospital") ||
          candidateStr.includes("ward") || candidateStr.includes("required") ||
          candidateStr.includes("start time") || candidateStr.includes("completion time")
        ) {
          headerRowIndex = r;
          break;
        }
      }
    }

    const headerRow = rawRows[headerRowIndex] as string[];
    const headers = (headerRow || []).map(h => String(h || "").toLowerCase().trim());

    const hospitalIdx = headers.findIndex(h => h.includes("hospital") || h.includes("based in") || h.includes("site"));
    const wardIdx = headers.findIndex(h => h.includes("ward") || h.includes("department") || h.includes("dept"));
    
    let dateIdx = headers.findIndex(h => h.includes("date the parking is required on") || h.includes("parking required") || h.includes("date required") || h.includes("valid from") || h.includes("valid_from"));
    if (dateIdx === -1 && headers.length > 8) {
      const colIHeader = headers[8];
      if (colIHeader.includes("date") || colIHeader.includes("required") || colIHeader.includes("parking") || colIHeader.includes("valid")) {
        dateIdx = 8;
      }
    }
    if (dateIdx === -1) {
      dateIdx = headers.findIndex(h => h.includes("date") && (h.includes("required") || h.includes("parking") || h.includes("start")));
    }

    const vrmIdx = headers.findIndex(h => h.includes("registration") || h.includes("plate") || h.includes("vrm"));
    const phoneIdx = headers.findIndex(h => h.includes("phone") || h.includes("mobile") || h.includes("contact") || h.includes("tel"));
    
    let startTimeIdx = headers.findIndex(h => h === "start time" || h === "start_time" || h.includes("submission start") || h.includes("submission time"));
    if (startTimeIdx === -1 && headers.length > 1) {
      const colBHeader = headers[1];
      if (colBHeader.includes("start") || colBHeader.includes("time") || colBHeader.includes("submit") || colBHeader.includes("creation")) {
        startTimeIdx = 1;
      }
    }
    if (startTimeIdx === -1 && headers.length >= 10) {
      startTimeIdx = 1;
    }

    let completionTimeIdx = headers.findIndex(h => 
      h === "completion time" || 
      h === "completion_time" || 
      h === "completiontime" ||
      h === "end time" ||
      h === "end_time" ||
      h === "endtime" ||
      h === "finish time" ||
      h === "finish_time" ||
      h === "date submitted" ||
      h === "submitted date" ||
      h.includes("completion time") || 
      h.includes("completed time") || 
      h.includes("submission end") ||
      h.includes("time completed") ||
      h.includes("completed at") ||
      h.includes("completion")
    );
    if (completionTimeIdx === -1 && headers.length > 2) {
      const colCHeader = headers[2];
      if (colCHeader.includes("completion") || colCHeader.includes("complete") || (startTimeIdx === 1 && colCHeader.includes("time"))) {
        completionTimeIdx = 2;
      }
    }
    
    let driverIdx = -1;
    if (headers.length > 11) {
      driverIdx = 11;
    } else {
      driverIdx = headers.findIndex(h => h.includes("driver") || h.includes("holder") || h.includes("full name"));
      if (driverIdx === -1) {
        driverIdx = headers.findIndex(h => h === "name");
      }
    }

    let emailIdx = -1;
    if (headers.length > 13) {
      emailIdx = 13;
    } else {
      emailIdx = headers.findIndex(h => h.includes("email") || h.includes("mail"));
    }

    const voucherIdx = findVoucherCodeColumn(headers);
    const validToIdx = findValidToColumn(headers);
    const idIdx = findFormIdColumn(headers);

    const records: CsvPermitRecord[] = [];

    for (let i = headerRowIndex + 1; i < rawRows.length; i++) {
      const columns = rawRows[i] as unknown[];
      if (!columns || !Array.isArray(columns) || columns.length < 1) continue;

      const rawVrm = vrmIdx !== -1 ? columns[vrmIdx] : "";
      const rawDriver = driverIdx !== -1 ? columns[driverIdx] : "";
      const rawHospital = hospitalIdx !== -1 ? columns[hospitalIdx] : "";
      const rawWard = wardIdx !== -1 ? columns[wardIdx] : "";
      const rawPhone = phoneIdx !== -1 ? columns[phoneIdx] : "";
      const rawEmail = emailIdx !== -1 ? columns[emailIdx] : "";
      const rawVoucher = voucherIdx !== -1 ? columns[voucherIdx] : "";
      
      let rawDate = "";
      if (dateIdx !== -1 && columns[dateIdx] !== undefined && columns[dateIdx] !== null) {
        const val = columns[dateIdx];
        if (typeof val === "number") {
          const date = new Date((val - 25569) * 86400 * 1000);
          if (!isNaN(date.getTime())) {
            const year = date.getUTCFullYear();
            const month = String(date.getUTCMonth() + 1).padStart(2, "0");
            const day = String(date.getUTCDate()).padStart(2, "0");
            rawDate = `${day}/${month}/${year}`;
          }
        } else {
          const s = String(val).trim();
          if (s && s !== "null" && s !== "undefined") rawDate = s;
        }
      }

      let rawExpiry = "";
      if (validToIdx !== -1 && columns[validToIdx] !== undefined && columns[validToIdx] !== null) {
        const val = columns[validToIdx];
        if (typeof val === "number") {
          const date = new Date((val - 25569) * 86400 * 1000);
          if (!isNaN(date.getTime())) {
            const year = date.getUTCFullYear();
            const month = String(date.getUTCMonth() + 1).padStart(2, "0");
            const day = String(date.getUTCDate()).padStart(2, "0");
            rawExpiry = `${day}/${month}/${year}`;
          }
        } else {
          const s = String(val).trim();
          if (s && s !== "null" && s !== "undefined") rawExpiry = s;
        }
      }

      let rawStartTime = "";
      if (startTimeIdx !== -1 && columns[startTimeIdx] !== undefined && columns[startTimeIdx] !== null) {
        const val = columns[startTimeIdx];
        if (typeof val === "number") {
          const date = new Date((val - 25569) * 86400 * 1000);
          if (!isNaN(date.getTime())) {
            const hours = String(date.getUTCHours()).padStart(2, "0");
            const minutes = String(date.getUTCMinutes()).padStart(2, "0");
            const seconds = String(date.getUTCSeconds()).padStart(2, "0");
            const year = date.getUTCFullYear();
            const month = String(date.getUTCMonth() + 1).padStart(2, "0");
            const day = String(date.getUTCDate()).padStart(2, "0");
            rawStartTime = `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
          }
        } else {
          const s = String(val).trim();
          if (s && s !== "null" && s !== "undefined") rawStartTime = s;
        }
      }

      let rawCompletionTime = "";
      if (completionTimeIdx !== -1 && columns[completionTimeIdx] !== undefined && columns[completionTimeIdx] !== null) {
        const val = columns[completionTimeIdx];
        if (typeof val === "number") {
          const date = new Date((val - 25569) * 86400 * 1000);
          if (!isNaN(date.getTime())) {
            const hours = String(date.getUTCHours()).padStart(2, "0");
            const minutes = String(date.getUTCMinutes()).padStart(2, "0");
            const seconds = String(date.getUTCSeconds()).padStart(2, "0");
            const year = date.getUTCFullYear();
            const month = String(date.getUTCMonth() + 1).padStart(2, "0");
            const day = String(date.getUTCDate()).padStart(2, "0");
            rawCompletionTime = `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
          }
        } else {
          const s = String(val).trim();
          if (s && s !== "null" && s !== "undefined") rawCompletionTime = s;
        }
      }

      let cleanVrm = rawVrm !== undefined && rawVrm !== null ? String(rawVrm).trim().toUpperCase().replace(/\s+/g, "") : "";
      let cleanDriver = rawDriver !== undefined && rawDriver !== null ? String(rawDriver).trim() : "";
      let cleanEmail = rawEmail !== undefined && rawEmail !== null ? String(rawEmail).trim() : "";
      let cleanPhone = rawPhone !== undefined && rawPhone !== null ? String(rawPhone).trim() : "";
      let cleanHospital = rawHospital !== undefined && rawHospital !== null ? String(rawHospital).trim() : "";
      let cleanWard = rawWard !== undefined && rawWard !== null ? String(rawWard).trim() : "";

      if (cleanVrm === "NULL" || cleanVrm === "UNDEFINED" || cleanVrm === "NONE" || cleanVrm === "N/A" || cleanVrm === "-") cleanVrm = "";
      if (cleanDriver.toLowerCase() === "null" || cleanDriver.toLowerCase() === "undefined") cleanDriver = "";
      if (cleanEmail.toLowerCase() === "null" || cleanEmail.toLowerCase() === "undefined") cleanEmail = "";

      const lowerDriver = cleanDriver.toLowerCase();
      if (
        lowerDriver === "driver's name" || lowerDriver === "driver name" ||
        lowerDriver === "driver" || lowerDriver === "name" ||
        lowerDriver === "full name" || lowerDriver.startsWith("total") ||
        lowerDriver.startsWith("subtotal") || lowerDriver === "id"
      ) {
        continue;
      }

      if (!cleanVrm && !cleanDriver && !cleanEmail && !rawDate && !rawStartTime) continue;

      let formIdStr = "";
      if (idIdx !== -1 && columns[idIdx] !== undefined && columns[idIdx] !== null) {
        const rawIdVal = String(columns[idIdx]).trim();
        const cleaned = formatFormId(rawIdVal);
        if (cleaned && cleaned !== "-") {
          formIdStr = cleaned;
        }
      } else if (columns[0] !== undefined && columns[0] !== null) {
        const rawIdVal = String(columns[0]).trim();
        const cleaned = formatFormId(rawIdVal);
        if (cleaned && cleaned !== "-") {
          formIdStr = cleaned;
        }
      }
      if (!formIdStr) {
        formIdStr = `row-${i + 1}`;
      }

      records.push({
        id: formIdStr,
        formId: formIdStr,
        hospital: cleanHospital || "Whipps Cross Hospital",
        ward: cleanWard || "Acorn Ward",
        dateRequired: rawDate,
        dateExpiry: resolveDateExpiry(rawDate, rawExpiry),
        vrm: cleanVrm || "PENDING",
        driverName: cleanDriver || "Driver's Name",
        phone: cleanPhone ? formatPhoneNumber(cleanPhone) : "",
        email: cleanEmail,
        voucherCode: cleanVoucherCodeValue(rawVoucher),
        startTime: rawStartTime || undefined,
        completionTime: rawCompletionTime || undefined,
        createdAt: rawStartTime ? String(rawStartTime).trim() : undefined
      });
    }

    const seenFormIds = new Set<string>();
    const uniqueRecords: CsvPermitRecord[] = [];
    for (const rec of records) {
      const key = String(rec.formId || rec.id || "");
      if (key && !seenFormIds.has(key)) {
        seenFormIds.add(key);
        uniqueRecords.push(rec);
      } else if (!key) {
        uniqueRecords.push(rec);
      }
    }

    return sortRecordsByFormIdDesc(uniqueRecords);
  } catch (error) {
    console.error("XLSX Parsing failed:", error);
    return [];
  }
}

export function isVoucherCodeMatch(qrOrCode1: string, code2: string): boolean {
  if (!qrOrCode1 || !code2) return false;
  const c1 = qrOrCode1.trim().toUpperCase();
  const c2 = code2.trim().toUpperCase();

  const placeholders = new Set(["-", "—", "PENDING", "N/A", "NA", "NONE", "UNKNOWN", "NULL", "UNDEFINED", "NO", "YES"]);
  if (placeholders.has(c1) || placeholders.has(c2)) return false;

  if (c1 === c2) return true;

  if (c2.length >= 6 && c1.length >= c2.length && (c1.endsWith(c2) || c1.includes(c2))) return true;
  if (c1.length >= 6 && c2.length >= c1.length && (c2.endsWith(c1) || c2.includes(c1))) return true;
  return false;
}

export function getTodayISO(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const MAX_DAYS_AHEAD = 2;

export function isDateRequiredOutsideValidWindow(dateRequiredStr?: string, referenceDateStr?: string): boolean {
  if (!dateRequiredStr) return false;
  const iso = parseDateToISO(String(dateRequiredStr));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;

  const refIso = referenceDateStr ? parseDateToISO(String(referenceDateStr)) : "";
  let today: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(refIso)) {
    const [ry, rm, rd] = refIso.split("-").map(Number);
    today = new Date(ry, rm - 1, rd, 0, 0, 0, 0);
  } else {
    const now = new Date();
    today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  }

  const [py, pm, pd] = iso.split("-").map(Number);
  const parkingDate = new Date(py, pm - 1, pd, 0, 0, 0, 0);

  const daysDiff = Math.floor((parkingDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  // A permit is 7 days (day 0 to day 6). By day 7 (e.g. 19/09 for 12/09), daysDiff is <= -7, meaning it has expired.
  return daysDiff <= -7 || daysDiff > MAX_DAYS_AHEAD;
}

/**
 * Evaluates whether a permit requested a start date that is 7 or more days in the past
 * relative to its submission timestamp (completion_time / start_time / created_at) or reference date.
 */
export function isPermitExpiredBackdate(record: any, referenceDateStr?: string): boolean {
  if (!record) return false;

  const validFromStr = record.validFrom || record.dateRequired;
  if (!validFromStr) return false;
  const validFromISO = parseDateToISO(String(validFromStr));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validFromISO)) return false;

  const [py, pm, pd] = validFromISO.split("-").map(Number);
  const validFromStartOfDayMs = new Date(py, pm - 1, pd, 0, 0, 0, 0).getTime();

  // Reference date/time preference:
  // 1. Completion / submission time on record (completionTime, startTime, createdAt, created_at, submissionDate)
  // 2. referenceDateStr passed in (e.g. todayDateOrReference or processingDate)
  // 3. Fallback to now
  const rawSubTime = record.completionTime || record.startTime || record.createdAt || record.created_at || record.submissionDate;
  let subMs: number | null = null;
  if (rawSubTime) {
    subMs = safeParseDateToTimestamp(rawSubTime);
  }
  if (!subMs || isNaN(subMs)) {
    const rawRef = referenceDateStr || record.todayDate || record.processingDate;
    if (rawRef) {
      subMs = safeParseDateToTimestamp(rawRef);
      if (!subMs || isNaN(subMs)) {
        const refIso = parseDateToISO(String(rawRef));
        if (/^\d{4}-\d{2}-\d{2}$/.test(refIso)) {
          const [ry, rm, rd] = refIso.split("-").map(Number);
          subMs = new Date(ry, rm - 1, rd, 0, 0, 0, 0).getTime();
        }
      }
    }
  }
  if (!subMs || isNaN(subMs)) {
    return false;
  }

  // 1. Precise timestamp check: valid_from date (00:00:00) is 7+ days (7 * 86400000 ms) earlier than submission timestamp
  const diffMs = subMs - validFromStartOfDayMs;
  if (diffMs >= 7 * 86400000) {
    return true;
  }

  // 2. Calendar day check: if submitted on 19/09 for 12/09, diff is >= 7 days
  const subDate = new Date(subMs);
  const subStartOfDayMs = new Date(subDate.getFullYear(), subDate.getMonth(), subDate.getDate(), 0, 0, 0, 0).getTime();
  const calendarDayDiff = Math.floor((subStartOfDayMs - validFromStartOfDayMs) / 86400000);
  if (calendarDayDiff >= 7) {
    return true;
  }

  return false;
}

export function parseUKDate(dateStr: string): string {
  if (!dateStr) return "";
  let s = String(dateStr).trim();
  if (!s) return "";

  s = s.split(/[\sT]+/)[0].trim();

  const ymdMatch = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
  if (ymdMatch) {
    const year = ymdMatch[1];
    const month = String(parseInt(ymdMatch[2], 10)).padStart(2, "0");
    const day = String(parseInt(ymdMatch[3], 10)).padStart(2, "0");
    return `${day}/${month}/${year}`;
  }

  const dmyMatch = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (dmyMatch) {
    const day = String(parseInt(dmyMatch[1], 10)).padStart(2, "0");
    const month = String(parseInt(dmyMatch[2], 10)).padStart(2, "0");
    let yearStr = dmyMatch[3];
    if (yearStr.length === 2) {
      yearStr = "20" + yearStr;
    }
    return `${day}/${month}/${yearStr}`;
  }

  return s;
}

/**
 * Safely parses various date/time formats into an epoch timestamp (ms) using local timezone methods.
 * Safely handles:
 * - DD/MM/YYYY HH:mm:ss, DD/MM/YYYY HH:mm, DD/MM/YYYY
 * - DD-MM-YYYY or DD.MM.YYYY
 * - YYYY-MM-DD HH:mm:ss, YYYY-MM-DD
 * - ISO 8601 strings (e.g. 2026-09-13T01:12:32.000Z)
 * - Numeric epoch ms or Excel serial dates
 * Returns null if the value is missing, empty, or cannot be parsed.
 */
export function safeParseDateToTimestamp(raw?: any): number | null {
  try {
    if (raw === undefined || raw === null || raw === "") return null;

    if (typeof raw === "number") {
      if (isNaN(raw) || raw <= 0) return null;
      if (raw > 30000 && raw < 60000) {
        const ms = (raw - 25569) * 86400 * 1000;
        return isNaN(ms) ? null : ms;
      }
      return raw;
    }

    const s = String(raw).trim();
    if (!s || s === "-" || s === "—" || s.toLowerCase() === "null" || s.toLowerCase() === "undefined") {
      return null;
    }

    // Handle date ranges e.g. "13/09/2026 - 19/09/2026" or "13/09/2026 to 19/09/2026"
    if (s.includes(" - ") || s.toLowerCase().includes(" to ")) {
      const parts = s.split(/\s+(?:to|\-)\s+/i);
      if (parts[0]) {
        return safeParseDateToTimestamp(parts[0]);
      }
    }

    // 1. UK format: DD/MM/YYYY [HH:mm[:ss]]
    const dmyMatch = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (dmyMatch) {
      const day = parseInt(dmyMatch[1], 10);
      const month = parseInt(dmyMatch[2], 10) - 1; // 0-indexed month
      let yearStr = dmyMatch[3];
      if (yearStr.length === 2) {
        const yy = parseInt(yearStr, 10);
        yearStr = (yy >= 70 ? "19" : "20") + yearStr;
      }
      const year = parseInt(yearStr, 10);
      const hours = dmyMatch[4] ? parseInt(dmyMatch[4], 10) : 0;
      const minutes = dmyMatch[5] ? parseInt(dmyMatch[5], 10) : 0;
      const seconds = dmyMatch[6] ? parseInt(dmyMatch[6], 10) : 0;

      if (day >= 1 && day <= 31 && month >= 0 && month <= 11 && year >= 1900 && year <= 2100) {
        const d = new Date(year, month, day, hours, minutes, seconds);
        const time = d.getTime();
        if (!isNaN(time) && time > 0) return time;
      }
    }

    // 2. ISO/Standard format: YYYY-MM-DD [HH:mm[:ss]]
    const ymdMatch = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (ymdMatch) {
      const year = parseInt(ymdMatch[1], 10);
      const month = parseInt(ymdMatch[2], 10) - 1;
      const day = parseInt(ymdMatch[3], 10);
      const hours = ymdMatch[4] ? parseInt(ymdMatch[4], 10) : 0;
      const minutes = ymdMatch[5] ? parseInt(ymdMatch[5], 10) : 0;
      const seconds = ymdMatch[6] ? parseInt(ymdMatch[6], 10) : 0;

      if (day >= 1 && day <= 31 && month >= 0 && month <= 11 && year >= 1900 && year <= 2100) {
        const d = new Date(year, month, day, hours, minutes, seconds);
        const time = d.getTime();
        if (!isNaN(time) && time > 0) return time;
      }
    }

    // 3. ISO 8601 with timezone (e.g. 2026-09-13T01:12:32.000Z)
    if (s.includes("T") || s.includes("Z")) {
      const parsed = Date.parse(s);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }

    // 4. Safe fallback using Date constructor
    try {
      const d = new Date(s);
      if (!isNaN(d.getTime()) && d.getTime() > 0) {
        return d.getTime();
      }
    } catch (e) {}

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Safe parser from DMY (or general date input) to ISO string (YYYY-MM-DD).
 * Sibling function to safeParseDateToTimestamp.
 */
export function safeParseDMYToISO(raw?: any): string {
  try {
    const ts = safeParseDateToTimestamp(raw);
    if (ts === null || isNaN(ts)) return "";
    const d = new Date(ts);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  } catch (e) {
    return "";
  }
}

export function parseDateToISO(dateStr?: string | null): string {
  if (!dateStr) return "";
  try {
    let s = String(dateStr).trim();
    if (!s || s === "-" || s === "—" || s.toLowerCase() === "null" || s.toLowerCase() === "undefined") {
      return "";
    }

    s = s.split(/[\sT]+/)[0].trim();
    
    const ymdMatch = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
    if (ymdMatch) {
      const year = ymdMatch[1];
      const month = String(parseInt(ymdMatch[2], 10)).padStart(2, '0');
      const day = String(parseInt(ymdMatch[3], 10)).padStart(2, '0');
      const mNum = parseInt(month, 10);
      const dNum = parseInt(day, 10);
      if (mNum >= 1 && mNum <= 12 && dNum >= 1 && dNum <= 31) {
        return `${year}-${month}-${day}`;
      }
    }

    if (!isNaN(Number(s)) && Number(s) > 30000 && Number(s) < 60000) {
      const d = new Date((Number(s) - 25569) * 86400 * 1000);
      if (!isNaN(d.getTime())) {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
    }

    let dateFormat = "UK";
    try {
      const saved = safeLocalStorage.getItem("concessions_date_format");
      if (saved === "US" || saved === "UK") {
        dateFormat = saved;
      } else {
        const resolved = safeLocalStorage.getItem("concessions_date_format_resolved");
        if (resolved === "US") {
          dateFormat = "US";
        }
      }
    } catch (e) {}

    const slashMatch = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
    if (slashMatch) {
      const part1 = parseInt(slashMatch[1], 10);
      const part2 = parseInt(slashMatch[2], 10);
      let yearStr = slashMatch[3];
      if (yearStr.length === 2) {
        const yy = parseInt(yearStr, 10);
        yearStr = (yy >= 70 ? "19" : "20") + yearStr;
      }

      let day = part1;
      let month = part2;
      
      if (dateFormat === "US") {
        day = part2;
        month = part1;
      }
      
      if (month > 12 && day <= 12) {
        const temp = month;
        month = day;
        day = temp;
      }
      
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        return `${yearStr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }

    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) {
      const year = parsed.getFullYear();
      const month = String(parsed.getMonth() + 1).padStart(2, '0');
      const day = String(parsed.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  } catch (e) {}

  return "";
}

export function addDays(dateStr: string, days: number): string {
  return addDaysSafe(dateStr, days);
}

export function formatPhoneNumber(phone: string): string {
  if (!phone) return "";
  let clean = phone.trim();
  if (clean.startsWith("+44")) {
    clean = "0" + clean.slice(3).trim();
  } else if (clean.startsWith("44") && clean.replace(/\s/g, "").length > 10) {
    clean = "0" + clean.slice(2).trim();
  }
  
  if (!clean.startsWith("0") && clean.length > 0) {
    clean = "0" + clean;
  }
  return clean;
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

export interface ParsedVoucherData {
  vrm?: string;
  code: string;
  status?: string;
  isUsed?: boolean;
  validFrom?: string;
  validTo?: string;
  valid_from?: string;
  valid_to?: string;
  [key: string]: any;
}

export function cleanVoucherDate(val: any): string {
  if (val === undefined || val === null) return "";
  
  if (val instanceof Date) {
    const year = val.getUTCFullYear();
    const month = String(val.getUTCMonth() + 1).padStart(2, '0');
    const day = String(val.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  const s = String(val).trim();
  if (!s || s === "-" || s === "—" || s === "N/A" || s === "NA") return "";

  if (s.includes('T')) {
    const datePart = s.split('T')[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
      return datePart;
    }
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  if (!isNaN(Number(s)) && Number(s) > 30000 && Number(s) < 60000) {
    const d = new Date((Number(s) - 25569) * 86400 * 1000);
    if (!isNaN(d.getTime())) {
      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }

  const range = parseDateRange(s);
  if (range && range.startISO) {
    return range.startISO;
  }

  const parsedIso = parseDateToISO(s);
  if (parsedIso && /^\d{4}-\d{2}-\d{2}$/.test(parsedIso)) {
    return parsedIso;
  }

  return "";
}

export function getDefaultSampleVouchers(targetDate?: string): ParsedVoucherData[] {
  const baseDate = targetDate ? (parseDateToISO(targetDate) || getTodayISO()) : getTodayISO();
  const validTo = addDaysSafe(baseDate, 6);
  const sampleCodes = [
    "CON9012JXM", "CON4471PLQ", "CON7783TRW", "CON2201MXK", "CON3319KLP",
    "CON5522BNM", "CON8891QWE", "CON1092ASD", "CON6634ZXC", "CON7745TYU",
    "CON8856UIO", "CON9967OPL", "CON1123GHJ", "CON2234KLM", "CON3345BNV",
    "CON4456CXV", "CON5567DSA", "CON6678REW", "CON7789TRE", "CON8890YTR"
  ];

  return sampleCodes.map(code => ({
    code,
    validFrom: baseDate,
    validTo: validTo,
    valid_from: baseDate,
    valid_to: validTo,
    status: "active",
    isUsed: false,
    uploadDate: baseDate
  }));
}

export function normalizeVoucherData(item: any): ParsedVoucherData {
  if (!item) return item;
  const rawCode = item.code || item.VoucherCode || item.Code || item.voucher_code || item.voucherCodesText || item.qrCode || item.serialNumber || "";
  const cleanCode = cleanVoucherCodeValue(rawCode);
  
  const startRaw = item.validFrom || item.valid_from || item.ValidFrom || item.date || item.dateRequired || item.uploadDate || item.IssueDate || item.created_at || item.startDate || item.start_date;
  const endRaw = item.validTo || item.valid_to || item.ValidTo || item.expires || item.expiryDate || item.endDate || item.end_date;
  
  const validFrom = cleanVoucherDate(startRaw) || undefined;
  const validTo = cleanVoucherDate(endRaw) || (validFrom ? addDaysSafe(validFrom, 6) : undefined);
  
  return {
    ...item,
    code: cleanCode.toUpperCase(),
    validFrom,
    validTo,
    valid_from: validFrom,
    valid_to: validTo,
    status: item.status || "active",
    isUsed: item.isUsed !== undefined ? Boolean(item.isUsed) : false,
  };
}

export function normalizeVouchersList(vouchers: any[]): ParsedVoucherData[] {
  if (!Array.isArray(vouchers)) return [];
  return vouchers
    .map(normalizeVoucherData)
    .filter(v => v && v.code && v.code !== "-");
}

export function parseVoucherFile(arrayBuffer: ArrayBuffer, fileName?: string): ParsedVoucherData[] {
  try {
    const workbook = XLSX.read(arrayBuffer, { type: "array", raw: true });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) return [];
    
    const worksheet = workbook.Sheets[firstSheetName];
    const rawRows = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1, raw: true });
    if (rawRows.length === 0) return [];

    let fileDate = "";
    if (fileName) {
      const matchRange = parseDateRange(fileName);
      if (matchRange && matchRange.startISO) {
        fileDate = matchRange.startISO;
      } else {
        const ymd = fileName.match(/(\d{4})[\/\-_\.](\d{1,2})[\/\-_\.](\d{1,2})/);
        if (ymd) {
          const y = ymd[1];
          const m = String(parseInt(ymd[2], 10)).padStart(2, '0');
          const d = String(parseInt(ymd[3], 10)).padStart(2, '0');
          fileDate = `${y}-${m}-${d}`;
        } else {
          const dmy = fileName.match(/(\d{1,2})[\/\-_\.](\d{1,2})[\/\-_\.](\d{4})/);
          if (dmy) {
            const p1 = parseInt(dmy[1], 10);
            const p2 = parseInt(dmy[2], 10);
            const y = dmy[3];
            const d = String(p1).padStart(2, '0');
            const m = String(p2).padStart(2, '0');
            fileDate = `${y}-${m}-${d}`;
          } else {
            const single = parseDateToISO(fileName);
            if (single && /^\d{4}-\d{2}-\d{2}$/.test(single)) {
              fileDate = single;
            }
          }
        }
      }
    }
    const defaultDate = fileDate || "";

    const firstRow = rawRows[0] as unknown[];
    if (!firstRow || firstRow.length === 0) return [];

    const headers = firstRow.map(h => String(h || "").toLowerCase().trim());
    
    const sampleRows = rawRows.slice(0, 15);
    const maxCols = Math.max(...sampleRows.map(r => Array.isArray(r) ? r.length : 0));

    const voucherIdx = findVoucherCodeColumn(headers);
    const validFromIdx = findValidFromColumn(headers);
    const validToIdx = findValidToColumn(headers);
    let vrmIdx = headers.findIndex(h => 
      h.includes("vrm") || 
      h.includes("plate") || 
      h.includes("registration") || 
      h.includes("reg") || 
      h.includes("vehicle")
    );

    let statusIdx = headers.findIndex(h => h.includes("status") || h.includes("state"));
    let isUsedIdx = headers.findIndex(h => h.includes("used") || h.includes("is_used") || h.includes("isused") || h.includes("assigned"));

    let isFirstRowData = false;
    for (const cell of firstRow) {
      const cellStr = String(cell || "").trim();
      if (cellStr.match(/^CON\d+JXM$/i) || (cellStr.length >= 8 && cleanVoucherDate(cellStr))) {
        isFirstRowData = true;
        break;
      }
    }

    const result: ParsedVoucherData[] = [];
    const seenCodes = new Set<string>();
    const hasHeaders = !isFirstRowData && (
      firstRow.some(cell => {
        const str = String(cell || "").toLowerCase().trim();
        return str.includes("code") || str.includes("valid") || str.includes("date") || str.includes("voucher") || str.includes("from") || str.includes("to") || str.includes("plate") || str.includes("vrm") || str.includes("status") || str.includes("used");
      })
    );
    const startIndex = hasHeaders ? 1 : 0;
    
    for (let i = startIndex; i < rawRows.length; i++) {
      const row = rawRows[i] as unknown[];
      if (!row || row.length === 0) continue;
      
      let rawCode = "";
      let vrm = "";
      let validFrom = "";
      let validTo = "";
      let status = "active";
      let isUsed = false;
      
      if (voucherIdx !== -1 && row[voucherIdx] !== undefined && row[voucherIdx] !== null) {
        rawCode = String(row[voucherIdx]).trim();
      } else {
        for (const cell of row) {
          const str = String(cell || "").trim();
          if (str && str.length >= 3 && !str.includes(" ") && cleanVoucherCodeValue(str) !== "-") {
            rawCode = str;
            break;
          }
        }
      }

      if (statusIdx !== -1 && row[statusIdx] !== undefined && row[statusIdx] !== null) {
        const sVal = String(row[statusIdx]).trim().toLowerCase();
        if (sVal) status = sVal;
      }

      if (isUsedIdx !== -1 && row[isUsedIdx] !== undefined && row[isUsedIdx] !== null) {
        const uVal = row[isUsedIdx];
        if (typeof uVal === "boolean") {
          isUsed = uVal;
        } else {
          const strVal = String(uVal).trim().toLowerCase();
          isUsed = strVal === "true" || strVal === "1" || strVal === "yes" || strVal === "used";
        }
      }

      const cleanCode = cleanVoucherCodeValue(rawCode);
      const lowerCode = cleanCode.toLowerCase();
      if (
        !cleanCode || 
        cleanCode === "-" || 
        lowerCode === "code" || 
        lowerCode === "voucher code" || 
        lowerCode === "vouchercode" || 
        lowerCode === "voucher_code" || 
        lowerCode === "vouchers" || 
        lowerCode === "qr code" ||
        lowerCode === "qrcode"
      ) {
        continue;
      }

      const upperCode = cleanCode.toUpperCase();
      if (seenCodes.has(upperCode)) {
        continue;
      }
      seenCodes.add(upperCode);
      
      if (vrmIdx !== -1 && row[vrmIdx] !== undefined) {
        vrm = String(row[vrmIdx]).toUpperCase().replace(/\s+/g, "");
      }

      const cleanVrmUpper = vrm.trim().toUpperCase();
      const isVrmPlaceholder = !cleanVrmUpper ||
        cleanVrmUpper === "-" ||
        cleanVrmUpper === "—" ||
        cleanVrmUpper === "PENDING" ||
        cleanVrmUpper === "N/A" ||
        cleanVrmUpper === "NA" ||
        cleanVrmUpper === "UNKNOWN" ||
        cleanVrmUpper === "NULL" ||
        cleanVrmUpper === "UNDEFINED";

      const parsedVrm = isVrmPlaceholder ? undefined : vrm;

      if (validFromIdx !== -1 && row[validFromIdx] !== undefined) {
        const rawFromStr = String(row[validFromIdx] || "").trim();
        const range = parseDateRange(rawFromStr);
        if (range && range.startISO) {
          validFrom = range.startISO;
          if (!validTo && range.endISO && range.endISO !== range.startISO) {
            validTo = range.endISO;
          }
        } else {
          validFrom = cleanVoucherDate(row[validFromIdx]);
        }
      }

      if (!validFrom) {
        for (let c = 0; c < row.length; c++) {
          if (c === voucherIdx || c === vrmIdx) continue;
          const cellVal = row[c];
          if (cellVal !== undefined && cellVal !== null) {
            const rawCellStr = String(cellVal || "").trim();
            const range = parseDateRange(rawCellStr);
            if (range && range.startISO) {
              validFrom = range.startISO;
              if (!validTo && range.endISO && range.endISO !== range.startISO) {
                validTo = range.endISO;
              }
              break;
            }
            const parsedDate = cleanVoucherDate(cellVal);
            if (parsedDate && /^\d{4}-\d{2}-\d{2}$/.test(parsedDate)) {
              validFrom = parsedDate;
              break;
            }
          }
        }
      }

      if (validToIdx !== -1 && row[validToIdx] !== undefined) {
        validTo = cleanVoucherDate(row[validToIdx]);
      }
      
      const effectiveValidFrom = validFrom || defaultDate || undefined;
      const effectiveValidTo = validTo || (effectiveValidFrom ? addDaysSafe(effectiveValidFrom, 6) : undefined);
      const effectiveUploadDate = defaultDate || getTodayISO();

      result.push({
        vrm: parsedVrm,
        code: upperCode,
        status: status || "active",
        isUsed: isUsed !== undefined ? isUsed : false,
        validFrom: effectiveValidFrom,
        validTo: effectiveValidTo,
        valid_from: effectiveValidFrom,
        valid_to: effectiveValidTo,
        uploadDate: effectiveUploadDate
      });
    }
    
    return result;
  } catch (e) {
    console.error("Error parsing voucher file", e);
    return [];
  }
}

export function addDaysSafe(dateStr?: string | null, days: number = 0): string {
  if (!dateStr) return "";
  let iso = String(dateStr).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    iso = parseDateToISO(iso);
  }
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const parts = iso.split("-");
  if (parts.length !== 3) return "";
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  const d = new Date(year, month, day);
  d.setDate(d.getDate() + days);
  const rYear = d.getFullYear();
  const rMonth = String(d.getMonth() + 1).padStart(2, '0');
  const rDay = String(d.getDate()).padStart(2, '0');
  return `${rYear}-${rMonth}-${rDay}`;
}

export function parseDateRange(dateStr: string): { startISO: string; endISO: string } | null {
  if (!dateStr) return null;
  const s = dateStr.trim();

  const rangeRegex = /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})\s*(?:to|and|\-|through|\s)\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/i;
  const match = s.match(rangeRegex);
  if (match) {
    const startISO = parseDateToISO(match[1]);
    const endISO = parseDateToISO(match[2]);
    if (startISO && endISO) {
      return { startISO, endISO };
    }
  }

  const singleISO = parseDateToISO(s);
  if (singleISO && /^\d{4}-\d{2}-\d{2}$/.test(singleISO)) {
    return { startISO: singleISO, endISO: singleISO };
  }

  return null;
}

export function getDatesInRange(startISO: string, endISO: string): string[] {
  const dates: string[] = [];
  let current = startISO;
  let count = 0;
  while (current <= endISO && count < 366) {
    dates.push(current);
    current = addDaysSafe(current, 1);
    count++;
  }
  return dates;
}

export function detectDateFormat(rawText: string): "US" | "UK" {
  if (!rawText) return "UK";
  
  const dateRegex = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/g;
  let maxFirst = 0;
  let maxSecond = 0;
  
  let match;
  while ((match = dateRegex.exec(rawText)) !== null) {
    const first = parseInt(match[1], 10);
    const second = parseInt(match[2], 10);
    if (first > maxFirst) maxFirst = first;
    if (second > maxSecond) maxSecond = second;
  }
  
  if (maxFirst > 12 && maxSecond <= 12) {
    return "UK";
  }
  if (maxSecond > 12 && maxFirst <= 12) {
    return "US";
  }
  
  const hasMsFormsHeaders = rawText.toLowerCase().includes("start time") && rawText.toLowerCase().includes("completion time");
  if (hasMsFormsHeaders) {
    return "US";
  }

  return "UK";
}

export function getMatchingPermits(database: CsvPermitRecord[], activeDateStr: string): CsvPermitRecord[] {
  if (!database || database.length === 0 || !activeDateStr) {
    return [];
  }

  const activeFromISO = parseDateToISO(activeDateStr);
  if (!activeFromISO) return [];

  return database.filter((record) => {
    const recDate = getRequestedPermitDateISO(record, activeFromISO);
    return recDate === activeFromISO;
  });
}

export function extractRecordVoucherCode(record: any): string {
  if (!record) return "";
  const raw = record.replacementCode ??
              record.voucherCode ??
              record.prePaidCode ??
              record.qrCode ??
              record.voucherCodesText ??
              record.serialNumber ??
              record.voucher ??
              record.code ??
              record["Voucher Code"] ??
              record["VOUCHER CODE"] ??
              record["Pre-Paid Code"] ??
              record["Pre Paid Code"] ??
              record["QR Code"] ??
              record["QR CODE"] ??
              "";
  if (typeof raw !== "string") {
    if (raw === null || raw === undefined) return "";
    return String(raw);
  }
  return raw;
}

export function isVoucherAvailableStatus(v: ParsedVoucherData | undefined | null): boolean {
  if (!v || !v.code) return false;
  const cleanCode = cleanVoucherCodeValue(v.code).toUpperCase();
  if (!cleanCode || cleanCode === "-" || cleanCode === "CANCELLED") return false;
  const status = String(v.status || "").toLowerCase();
  if (v.isUsed === true || status === "used" || status === "assigned" || status === "sent" || status === "completed") {
    return false;
  }
  return true;
}

export function isVoucherVrmCompatible(vVrm: string | undefined | null, cleanVrm: string): boolean {
  if (!vVrm) return true;
  const vVrmClean = String(vVrm).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const isUnrestricted = !vVrmClean ||
    ["-", "—", "PENDING", "N/A", "NA", "UNKNOWN", "NULL", "UNDEFINED"].includes(vVrmClean);
  if (isUnrestricted) return true;
  return cleanVrm !== "" && vVrmClean === cleanVrm;
}

export function getRequestedPermitDateISO(record?: any, fallbackDateStr?: string): string {
  if (!record) {
    return fallbackDateStr ? (parseDateToISO(fallbackDateStr) || "") : "";
  }
  const rawDate = record?.dateRequired ??
                  record?.validFrom ??
                  record?.valid_from ??
                  record?.["Date Required"] ??
                  record?.["DATE REQUIRED"] ??
                  record?.["Valid From"] ??
                  record?.["VALID FROM"];

  if (rawDate) {
    const range = parseDateRange(String(rawDate));
    if (range && range.startISO) {
      return range.startISO;
    }
    const iso = parseDateToISO(String(rawDate));
    if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      return iso;
    }
  }

  if (fallbackDateStr) {
    const fbIso = parseDateToISO(fallbackDateStr);
    if (fbIso && /^\d{4}-\d{2}-\d{2}$/.test(fbIso)) {
      return fbIso;
    }
  }

  const secondaryDate = record?.startTime ?? record?.completionTime ?? record?.todayDate ?? record?.createdAt ?? record?.processingDate;
  if (secondaryDate) {
    const iso = parseDateToISO(String(secondaryDate));
    if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      return iso;
    }
  }

  return "";
}

export function getVoucherDateISO(voucher: ParsedVoucherData | undefined | null): string {
  if (!voucher) return "";
  const rawFrom = voucher.validFrom ||
                  voucher.valid_from ||
                  voucher.ValidFrom ||
                  voucher.startDate ||
                  voucher.start_date ||
                  voucher.date ||
                  voucher.dateRequired ||
                  voucher.uploadDate;
  if (!rawFrom) return "";
  const vIso = parseDateToISO(String(rawFrom));
  return vIso && /^\d{4}-\d{2}-\d{2}$/.test(vIso) ? vIso : "";
}

export function isVoucherInValidityPeriod(
  voucher: ParsedVoucherData | undefined | null,
  targetDateStr: string
): boolean {
  if (!voucher || !voucher.code || !targetDateStr) return false;
  const cleanCode = cleanVoucherCodeValue(voucher.code).toUpperCase();
  if (!cleanCode || cleanCode === "-" || cleanCode === "CANCELLED" || cleanCode === "PENDING") {
    return false;
  }

  const targetDateISO = parseDateToISO(targetDateStr) || targetDateStr;
  if (!targetDateISO || !/^\d{4}-\d{2}-\d{2}$/.test(targetDateISO)) return false;

  const rawFrom = voucher.validFrom ||
                  voucher.valid_from ||
                  voucher.ValidFrom ||
                  voucher.startDate ||
                  voucher.start_date ||
                  voucher.date ||
                  voucher.dateRequired ||
                  voucher.uploadDate;
  const rawTo = voucher.validTo ||
                voucher.valid_to ||
                voucher.ValidTo ||
                voucher.endDate ||
                voucher.end_date;

  const vFrom = rawFrom ? (parseDateToISO(String(rawFrom)) || "") : "";
  const vTo = rawTo ? (parseDateToISO(String(rawTo)) || "") : "";

  if (vFrom && vTo) {
    return targetDateISO >= vFrom && targetDateISO <= vTo;
  }

  // Voucher validity is a strict inclusive date range.
  // A voucher is eligible only when BOTH ValidFrom and ValidTo are
  // present and: ValidFrom <= targetDate <= ValidTo.
  // Never infer an open-ended period and never fall back to another date.
  if (!vFrom || !vTo) return false;

  return targetDateISO >= vFrom && targetDateISO <= vTo;
}

export function isVoucherExactPeriodEligible(
  voucher: ParsedVoucherData | undefined | null,
  requestedDateStr: string,
  permitToDateStr?: string
): boolean {
  if (!voucher || !voucher.code || !requestedDateStr) return false;
  return isVoucherForPermitDateRange(voucher, requestedDateStr, permitToDateStr);
}

export function isRecordCancelledCanonical(record: any, todayDateOrReference?: string, database?: CsvPermitRecord[]): boolean {
  if (!record) return false;
  if (record.cancellationReason === "MANUAL" || record.cancellationReason === "BLOCKLIST") return true;
  if (isVrmSilentBlockedSync(record.vrm) || String(record.status || "").trim().toUpperCase() === "BLOCKED") return true;

  const rawRefDate = todayDateOrReference || record.todayDate || record.processingDate;
  const referenceDate = rawRefDate 
    ? (parseDateToISO(String(rawRefDate)) || "") 
    : "";
  const isBackdate = isPermitExpiredBackdate(record, referenceDate);
  const dateRequired = record.dateRequired || record.validFrom || "";
  const reqIso = parseDateToISO(dateRequired);
  const isExpiredDate = referenceDate && reqIso && Math.floor((new Date(reqIso + "T00:00:00").getTime() - new Date(referenceDate + "T00:00:00").getTime()) / 86400000) <= -7;
  if (isBackdate || Boolean(isExpiredDate)) return true;

  const rawSubDate = record.completionTime || record.startTime || record.createdAt || record.submissionDate;
  const subDateIso = rawSubDate ? parseDateToISO(String(rawSubDate)) : "";
  if (subDateIso && reqIso) {
    const aheadDays = Math.floor((new Date(reqIso + "T00:00:00").getTime() - new Date(subDateIso + "T00:00:00").getTime()) / 86400000);
    if (aheadDays > MAX_DAYS_AHEAD) {
      return true;
    }
  }

  // Explicitly active record: do not let stale CANCELLED string in voucherCode override active status
  if (record.isCancelled === false && String(record.status || "").trim().toUpperCase() === "ACTIVE") {
    return false;
  }

  // ⭐ Live duplicate check: same VRM, requested within overlapping dates of an earlier non-cancelled request
  if (database && database.length > 0) {
    if (checkIsBlockedDuplicate(record, database, referenceDate)) {
      return true;
    }
    return false;
  } else if (record.isCancelled === true || (typeof record.status === "string" && record.status.trim().toLowerCase().includes("cancel"))) {
    return true;
  }

  return false;
}

export function getSpreadsheetMatchingAllocationsMap(
  matchingPermits: any[] = [],
  database: CsvPermitRecord[] = [],
  processingDate: string = "",
  vouchersDatabase: ParsedVoucherData[] = [],
  customVouchersMap?: Record<string, string>
): Map<string, string> {
  const map = new Map<string, string>();
  const activeFromISO = parseDateToISO(processingDate);

  const targetPermits = (matchingPermits && matchingPermits.length > 0)
    ? matchingPermits
    : (activeFromISO ? getMatchingPermits(database, activeFromISO) : database);

  if (!targetPermits || targetPermits.length === 0) return map;

  const sortedMatchingPermits = [...targetPermits].sort((a, b) => {
    const aId = Number(String(a.formId ?? a.id ?? 0).replace(/[^0-9]/g, "")) || 0;
    const bId = Number(String(b.formId ?? b.id ?? 0).replace(/[^0-9]/g, "")) || 0;
    return aId - bId;
  });

  const effectiveDatabase = database.length > 0 ? database : sortedMatchingPermits;
  const internalAssignedSet = new Set<string>();

  // ⭐ PERFORMANCE CACHE: Pre-index vouchersDatabase for instant O(1) lookups
  const vouchersByCode = new Map<string, ParsedVoucherData[]>();
  const availableVouchersByPeriod = new Map<string, ParsedVoucherData[]>();

  (vouchersDatabase || []).forEach(v => {
    if (!v || !v.code) return;
    const clean = cleanVoucherCodeValue(v.code).toUpperCase();
    if (!clean) return;
    
    let list = vouchersByCode.get(clean);
    if (!list) {
      list = [];
      vouchersByCode.set(clean, list);
    }
    list.push(v);

    if (isVoucherAvailableStatus(v)) {
      const vFrom = v.validFrom || "";
      const vTo = v.validTo || "";
      const key = `${vFrom}_${vTo}`;
      let pList = availableVouchersByPeriod.get(key);
      if (!pList) {
        pList = [];
        availableVouchersByPeriod.set(key, pList);
      }
      pList.push(v);
    }
  });

  const checkCodeExistsForPeriod = (cleanCode: string, reqFrom?: string, reqTo?: string): boolean => {
    if (!vouchersDatabase || vouchersDatabase.length === 0) return true;
    const matches = vouchersByCode.get(cleanCode);
    if (!matches || matches.length === 0) return false;
    if (!reqFrom) return true;
    return matches.some(v => isVoucherExactPeriodEligible(v, reqFrom, reqTo));
  };

  sortedMatchingPermits.forEach((r, idx) => {
    const recordKey = String(r.formId || r.id || idx);
    const reqDate = getRequestedPermitDateISO(r, processingDate);
    const reqDateTo = r.validTo 
      ? (parseDateToISO(r.validTo) || (reqDate ? addDaysSafe(reqDate, 6) : ""))
      : (r.dateExpiry ? (parseDateToISO(r.dateExpiry) || (reqDate ? addDaysSafe(reqDate, 6) : "")) : (reqDate ? addDaysSafe(reqDate, 6) : ""));

    if (isVrmSilentBlockedSync(r.vrm)) {
      map.set(recordKey, "BLOCKED");
      return;
    }

    if (isRecordCancelledCanonical(r, reqDate || processingDate, effectiveDatabase)) {
      map.set(recordKey, "CANCELLED");
      return;
    }

    if (customVouchersMap) {
      const rVrm = (r.vrm || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      const rDateIso = reqDate;
      const keyWithDate = rDateIso ? `${rVrm}_${rDateIso}` : rVrm;

      const hasStableId = Boolean(
        (r.formId !== undefined && r.formId !== null && String(r.formId).trim() !== "") ||
        (r.id !== undefined && r.id !== null && String(r.id).trim() !== "")
      );
      const customOverride = (r.formId ? customVouchersMap[String(r.formId)] : undefined) ||
                             (r.id ? customVouchersMap[String(r.id)] : undefined) ||
                             (!hasStableId && !isPlaceholderVrm(rVrm) ? (customVouchersMap[keyWithDate] || customVouchersMap[rVrm]) : undefined);

      if (customOverride && customOverride !== "-" && customOverride.toUpperCase() !== "CANCELLED") {
        const clean = String(customOverride).trim().split(/[\n,;\s]+/)[0]?.trim().toUpperCase();
        // Fast O(1) check if code exists in vouchersDatabase for this date range
        const codeExistsInDb = checkCodeExistsForPeriod(clean, reqDate, reqDateTo);
        if (codeExistsInDb && clean && clean !== "-" && clean !== "CANCELLED") {
          map.set(recordKey, clean);
          internalAssignedSet.add(clean);
          return;
        }
      }
    }

    const rawCode = extractRecordVoucherCode(r);
    const rawCodeUpper = rawCode ? String(rawCode).trim().toUpperCase() : "";
    if (rawCode && rawCode !== "-" && rawCodeUpper !== "CANCELLED") {
      const clean = cleanVoucherCodeValue(String(rawCode)).toUpperCase();
      // Fast O(1) check if code exists in vouchersDatabase for this date range
      const codeExistsInDb = checkCodeExistsForPeriod(clean, reqDate, reqDateTo);
      if (codeExistsInDb && clean && clean !== "-" && clean !== "CANCELLED") {
        map.set(recordKey, clean);
        internalAssignedSet.add(clean);
        return;
      }
    }
  });

  sortedMatchingPermits.forEach((r, idx) => {
    const recordKey = String(r.formId || r.id || idx);
    if (map.has(recordKey)) return;

    const reqDateD = getRequestedPermitDateISO(r, processingDate);
    const reqDateToD = r.validTo 
      ? (parseDateToISO(r.validTo) || (reqDateD ? addDaysSafe(reqDateD, 6) : ""))
      : (r.dateExpiry ? (parseDateToISO(r.dateExpiry) || (reqDateD ? addDaysSafe(reqDateD, 6) : "")) : (reqDateD ? addDaysSafe(reqDateD, 6) : ""));

    if (isRecordCancelledCanonical(r, reqDateD || processingDate, effectiveDatabase)) {
      map.set(recordKey, "CANCELLED");
      return;
    }

    if (!reqDateD) {
      map.set(recordKey, "-");
      return;
    }

    // Fast O(1) bucket retrieval for this exact period if available
    const periodBucket = availableVouchersByPeriod.get(`${reqDateD}_${reqDateToD}`);
    const candidateVouchers = periodBucket && periodBucket.length > 0 
      ? periodBucket 
      : (vouchersDatabase || []);

    const eligibleVouchers = candidateVouchers.filter(v => {
      if (!isVoucherAvailableStatus(v)) return false;
      const cleanCode = cleanVoucherCodeValue(v.code).toUpperCase();
      if (internalAssignedSet.has(cleanCode)) return false;
      return isVoucherExactPeriodEligible(v, reqDateD, reqDateToD);
    });

    const rVrm = (r.vrm || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    let nextCode = "";

    if (rVrm) {
      const vrmMatch = eligibleVouchers.find(v => {
        const vVrm = (v.vrm || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        return vVrm && vVrm === rVrm;
      });
      if (vrmMatch && vrmMatch.code) {
        nextCode = cleanVoucherCodeValue(vrmMatch.code).toUpperCase();
      }
    }

    if (!nextCode) {
      const genericMatch = eligibleVouchers.find(v => isVoucherVrmCompatible(v.vrm, rVrm));
      if (genericMatch && genericMatch.code) {
        nextCode = cleanVoucherCodeValue(genericMatch.code).toUpperCase();
      }
    }

    if (nextCode && nextCode !== "-" && nextCode !== "CANCELLED") {
      map.set(recordKey, nextCode);
      internalAssignedSet.add(nextCode);
    } else {
      map.set(recordKey, "-");
    }
  });

  return map;
}

export function getSpreadsheetMatchingAssignedCodes(
  matchingPermits: any[] = [],
  database: CsvPermitRecord[] = [],
  processingDate: string = "",
  vouchersDatabase: ParsedVoucherData[] = []
): Set<string> {
  const assignedCodes = new Set<string>();
  const allocationsMap = getSpreadsheetMatchingAllocationsMap(
    matchingPermits,
    database,
    processingDate,
    vouchersDatabase
  );

  allocationsMap.forEach((code) => {
    if (code && code !== "-" && code !== "CANCELLED") {
      const clean = cleanVoucherCodeValue(code).toUpperCase();
      if (clean && clean !== "-" && clean !== "CANCELLED") {
        assignedCodes.add(clean);
      }
    }
  });

  return assignedCodes;
}

export function getUnusedVouchersForDate(
  vouchersDatabase: ParsedVoucherData[],
  database: CsvPermitRecord[],
  targetISO: string,
  currentVrm: string = "",
  currentRecord: any = null,
  spreadsheetMatches?: any[]
): ParsedVoucherData[] {
  if (!vouchersDatabase || vouchersDatabase.length === 0 || !targetISO) {
    return [];
  }

  const targetDateISO = parseDateToISO(targetISO) || targetISO;
  const targetEndISO = (currentRecord && currentRecord.validTo)
    ? (parseDateToISO(currentRecord.validTo) || addDaysSafe(targetDateISO, 6))
    : addDaysSafe(targetDateISO, 6);
  const currentVrmClean = (currentVrm || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  const dailyVouchersForDate = vouchersDatabase.filter((v) => {
    return isVoucherForPermitDateRange(v, targetDateISO, targetEndISO);
  });

  if (dailyVouchersForDate.length === 0) {
    return [];
  }

  const dailyVouchersMap = new Map<string, ParsedVoucherData>();
  dailyVouchersForDate.forEach((v) => {
    if (!v) return;

    const raw =
      v.code ||
      (v as any).voucherCode ||
      (v as any).qrCode ||
      (v as any).serialNumber ||
      (v as any).prePaidCode;

    if (!raw) return;

    const clean = cleanVoucherCodeValue(raw).toUpperCase();
    if (
      clean &&
      clean !== "-" &&
      clean !== "CANCELLED" &&
      clean !== "PENDING"
    ) {
      if (!dailyVouchersMap.has(clean)) {
        dailyVouchersMap.set(clean, { ...v, code: clean });
      }
    }
  });

  const allAssignedCodesSet = new Set<string>();

  const consumeAssignedCode = (rawCode: any) => {
    if (rawCode === undefined || rawCode === null) return;

    const parts = String(rawCode).split(/[\n,;\s]+/);

    for (const part of parts) {
      const clean = cleanVoucherCodeValue(part).toUpperCase();
      if (
        !clean ||
        clean === "-" ||
        clean === "CANCELLED" ||
        clean === "PENDING" ||
        clean === "N/A" ||
        clean === "NA" ||
        clean === "NONE" ||
        clean === "NULL" ||
        clean === "UNDEFINED"
      ) {
        continue;
      }
      allAssignedCodesSet.add(clean);
    }
  };

  const collectAssignedCodesFromRecord = (permit: any) => {
    if (!permit) return;

    const reqDate = getRequestedPermitDateISO(permit, targetDateISO);
    if (
      isVrmSilentBlockedSync(permit.vrm) ||
      isRecordCancelledCanonical(permit, reqDate || targetDateISO, database) ||
      isRecordCancelled(permit, reqDate || targetDateISO, database)
    ) {
      return;
    }

    consumeAssignedCode(permit.replacementCode);
    consumeAssignedCode(permit.originalVoucherCode);
    consumeAssignedCode(permit.voucherCode);
    consumeAssignedCode(permit.prePaidCode);
    consumeAssignedCode(permit.qrCode);
    consumeAssignedCode(permit.voucherCodesText);
    consumeAssignedCode(permit.serialNumber);
    consumeAssignedCode(permit.voucher);
    consumeAssignedCode(permit.code);
    consumeAssignedCode(permit.qrOverride);
    consumeAssignedCode(permit["Voucher Code"]);
    consumeAssignedCode(permit["VOUCHER CODE"]);
    consumeAssignedCode(permit["Pre-Paid Code"]);
    consumeAssignedCode(permit["Pre Paid Code"]);
    consumeAssignedCode(permit["QR Code"]);
    consumeAssignedCode(permit["QR CODE"]);
  };

  (database || []).forEach(collectAssignedCodesFromRecord);

  if (Array.isArray(spreadsheetMatches)) {
    spreadsheetMatches.forEach(collectAssignedCodesFromRecord);
  }

  if (currentRecord) {
    collectAssignedCodesFromRecord(currentRecord);
  }

  const spreadsheetAssigned = getSpreadsheetMatchingAssignedCodes(
    spreadsheetMatches || [],
    database,
    targetDateISO,
    vouchersDatabase
  );
  spreadsheetAssigned.forEach((code) => {
    const clean = cleanVoucherCodeValue(code).toUpperCase();
    if (
      clean &&
      clean !== "-" &&
      clean !== "CANCELLED" &&
      clean !== "PENDING"
    ) {
      allAssignedCodesSet.add(clean);
    }
  });

  const activeUnassignedCodes: ParsedVoucherData[] = [];
  const seenCodes = new Set<string>();

  dailyVouchersMap.forEach((voucher, codeUpper) => {
    if (allAssignedCodesSet.has(codeUpper)) return;

    for (const assigned of allAssignedCodesSet) {
      if (isVoucherCodeMatch(assigned, codeUpper)) {
        return;
      }
    }

    const status = String(voucher.status || "").trim().toLowerCase();
    if (
      voucher.isUsed === true ||
      status === "used" ||
      status === "assigned" ||
      status === "sent" ||
      status === "completed"
    ) {
      return;
    }

    if (voucher.vrm) {
      const vVrmClean = String(voucher.vrm)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");

      const isUnrestricted =
        !vVrmClean ||
        ["-", "—", "PENDING", "N/A", "NA", "UNKNOWN", "NULL"].includes(
          vVrmClean
        );

      if (
        !isUnrestricted &&
        currentVrmClean &&
        vVrmClean !== currentVrmClean
      ) {
        return;
      }
    }

    if (!seenCodes.has(codeUpper)) {
      seenCodes.add(codeUpper);
      activeUnassignedCodes.push(voucher);
    }
  });

  return activeUnassignedCodes;
}

export interface PermitRecord {
  id?: string;
  formId?: string | number;
  vrm?: string;
  driverName?: string;
  name?: string;
  email?: string;
  driverEmail?: string;
  phone?: string;
  hospital?: string;
  ward?: string;
  status?: string;
  isDispatched?: boolean;
  dispatchedAt?: string;
  validFrom?: string;
  validTo?: string;
  expires?: string;
  dateRequired?: string;
  dateExpiry?: string;
  isCancelled?: boolean;
  voucherCode?: string;
  prePaidCode?: string;
  qrCode?: string;
  serialNumber?: string;
  voucherCodesText?: string;
  voucher?: string;
  code?: string;
  startTime?: string;
  createdAt?: string;
  created_at?: string;
  completionTime?: string;
  todayDate?: string;
  processingDate?: string;
  submissionDate?: string;
  department?: string;
  title?: string;
  site?: string;
  qrOverride?: string;
  emailType?: "SEND_CONCESSION" | "RESEND_CONCESSION" | string;
  isResend?: boolean;
  emailTemplate?: "new" | "replacement";
  hasOriginalVoucher?: boolean;
  [key: string]: any;
}

export const getRecordStatus = (
  record: PermitRecord,
  _processingDateStr: string,
  dispatchedIdsSet: Set<string> = new Set()
): '✓ Sent' | 'Pending' | 'Expired' | 'Cancelled' | '-' => {
  if (record.status === 'Cancelled' || record.isCancelled) return 'Cancelled';

  const formId = record.formId || record.id || "";
  const cleanFormId = formId ? String(formId).replace(/[^0-9]/g, "") : "";
  const cleanVrm = (record.vrm || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  const isConfirmedDispatched =
    (record.id && dispatchedIdsSet.has(record.id)) ||
    (cleanFormId && dispatchedIdsSet.has(cleanFormId)) ||
    (cleanVrm && dispatchedIdsSet.has(cleanVrm)) ||
    (record.isDispatched === true && Boolean(record.dispatchedAt));

  if (isConfirmedDispatched) return '✓ Sent';
  return 'Pending';
};

export function findDuplicateCodes(database: CsvPermitRecord[]): string[] {
  const codeMap = new Map<string, string[]>();
  database.forEach(record => {
    const rawVal = record.voucherCode || record.prePaidCode;
    if (rawVal && rawVal !== "-" && rawVal !== "CANCELLED") {
      const lines = rawVal.split(/[\n,;\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
      lines.forEach(code => {
        if (!code || code === "-" || code === "CANCELLED") return;
        if (!codeMap.has(code)) {
          codeMap.set(code, []);
        }
        codeMap.get(code)!.push(record.id || String(record.formId) || "");
      });
    }
  });

  return Array.from(codeMap.entries())
    .filter(([_code, records]) => records.length > 1)
    .map(([code]) => code);
}

export function parseFullDateTimeMs(str?: string, fallbackIsoDate?: string): number | null {
  if (!str) return null;
  const s = String(str).trim();
  if (!s || s === "-" || s === "null" || s === "undefined") return null;

  if (s.includes("T")) {
    const parsedISO = Date.parse(s);
    if (!isNaN(parsedISO)) return parsedISO;
  }

  const timeMatch = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AP]M))?/i);
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  let hasTime = false;

  if (timeMatch) {
    hours = parseInt(timeMatch[1], 10) || 0;
    minutes = parseInt(timeMatch[2], 10) || 0;
    seconds = timeMatch[3] ? (parseInt(timeMatch[3], 10) || 0) : 0;
    const ampm = timeMatch[4];
    if (ampm) {
      if (/PM/i.test(ampm) && hours < 12) hours += 12;
      if (/AM/i.test(ampm) && hours === 12) hours = 0;
    }
    hasTime = true;
  }

  const parsedDateISO = parseDateToISO(s);
  const resolvedFallbackISO = fallbackIsoDate ? parseDateToISO(fallbackIsoDate) : "";
  const isoDate = (parsedDateISO && /^\d{4}-\d{2}-\d{2}$/.test(parsedDateISO))
    ? parsedDateISO
    : (resolvedFallbackISO && /^\d{4}-\d{2}-\d{2}$/.test(resolvedFallbackISO))
      ? resolvedFallbackISO
      : "";

  if (isoDate) {
    const dateParts = isoDate.split("-").map(Number);
    if (dateParts.length === 3) {
      const [y, m, d] = dateParts;
      return new Date(y, m - 1, d, hours, minutes, seconds).getTime();
    }
  }

  if (hasTime) {
    return new Date(2000, 0, 1, hours, minutes, seconds).getTime();
  }

  const dateObj = new Date(s);
  if (!isNaN(dateObj.getTime()) && dateObj.getTime() > 0) {
    return dateObj.getTime();
  }

  return null;
}

export function extractRecordNumericFormId(record?: any): number {
  if (!record) return 0;
  try {
    const raw = record?.formId !== undefined && record?.formId !== null && record?.formId !== ""
      ? record.formId
      : (record?.id !== undefined && record?.id !== null && record?.id !== "" ? record.id : undefined);

    if (raw === undefined || raw === null) return 0;
    if (typeof raw === "number" && !isNaN(raw)) return raw;

    const str = String(raw).trim();
    const digits = str.replace(/\D/g, "");
    if (digits) {
      const parsed = parseInt(digits, 10);
      if (!isNaN(parsed)) return parsed;
    }
  } catch (e) {}
  return 0;
}

export function extractRecordSubmissionTimeMs(record?: any, fallbackDateStr?: string): number {
  if (!record) return 0;

  try {
    const recDateRaw = record?.dateRequired ?? 
                       record?.validFrom ?? 
                       record?.todayDate ?? 
                       record?.["Date Required"] ?? 
                       record?.["Valid From"] ?? 
                       fallbackDateStr ?? 
                       "";
    const recDateISO = recDateRaw ? (parseDateToISO(String(recDateRaw)) || "") : "";

    const timestampFields = [
      record?.startTime,
      record?.start_time,
      record?.submissionTime,
      record?.submission_time,
      record?.submittedAt,
      record?.submitted_at,
      record?.completionTime,
      record?.completion_time,
      record?.createdAt,
      record?.created_at
    ];

    for (const field of timestampFields) {
      if (field !== undefined && field !== null) {
        const s = String(field).trim();
        if (!s || s === "-" || s.toLowerCase() === "null" || s.toLowerCase() === "undefined") continue;
        
        const ms = parseFullDateTimeMs(s, recDateISO);
        if (ms !== null && ms > 0) return ms;

        const dateObj = new Date(s);
        if (!isNaN(dateObj.getTime()) && dateObj.getTime() > 0) {
          return dateObj.getTime();
        }
      }
    }

    return 0;
  } catch (e) {
    return 0;
  }
}

export function isSamePermitRecord(a?: any, b?: any): boolean {
  if (a === b) return true;
  if (!a || !b) return false;

  try {
    const idA = extractRecordNumericFormId(a);
    const idB = extractRecordNumericFormId(b);
    if (idA > 0 && idB > 0 && idA === idB) return true;

    const rawIdA = String(a?.formId ?? a?.id ?? "").trim();
    const rawIdB = String(b?.formId ?? b?.id ?? "").trim();
    if (rawIdA && rawIdB && rawIdA !== "-" && rawIdA === rawIdB) return true;

    const hasDistinctExplicitIds = (idA > 0 && idB > 0) || (rawIdA && rawIdB && rawIdA !== "-" && rawIdB !== "-");
    if (hasDistinctExplicitIds) return false;

    const vrmA = (a?.vrm || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const vrmB = (b?.vrm || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (vrmA && vrmB && vrmA === vrmB) {
      const timeA = extractRecordSubmissionTimeMs(a);
      const timeB = extractRecordSubmissionTimeMs(b);
      if (timeA > 0 && timeB > 0 && timeA === timeB) return true;

      const nameA = (a?.driverName || a?.name || "").trim().toLowerCase();
      const nameB = (b?.driverName || b?.name || "").trim().toLowerCase();
      const dateA = parseDateToISO(a?.dateRequired || a?.validFrom || "");
      const dateB = parseDateToISO(b?.dateRequired || b?.validFrom || "");
      if (nameA && nameB && nameA === nameB && dateA && dateB && dateA === dateB && timeA === timeB) {
        return true;
      }
    }

    return false;
  } catch (e) {
    return false;
  }
}

// ⭐ High-performance WeakMap / Map caches for submission times, form IDs, and dataset indices
const submissionTimeCache = new WeakMap<object, number>();
const formIdCache = new WeakMap<object, number>();
const dbIndexMapCache = new WeakMap<CsvPermitRecord[], Map<object, number>>();

export function getRecordDatasetIndex(
  record: any,
  database: CsvPermitRecord[],
  formIdRecord?: number,
  rawIdRecord?: string
): number {
  if (!database || database.length === 0) return -1;
  try {
    // Check if we have pre-indexed the database array
    let indexMap = dbIndexMapCache.get(database);
    if (!indexMap) {
      indexMap = new Map<object, number>();
      for (let i = 0; i < database.length; i++) {
        const item = database[i];
        if (item && typeof item === "object") {
          indexMap.set(item, i);
        }
      }
      dbIndexMapCache.set(database, indexMap);
    }

    if (record && typeof record === "object" && indexMap.has(record)) {
      return indexMap.get(record)!;
    }

    const numId = formIdRecord ?? extractRecordNumericFormId(record);
    const rawId = rawIdRecord ?? String(record?.formId ?? record?.id ?? "").trim();

    const idx = database.findIndex(r => {
      if (isSamePermitRecord(r, record)) return true;
      const formIdR = extractRecordNumericFormId(r);
      if (numId > 0 && formIdR > 0 && numId === formIdR) return true;
      const rawIdR = String(r?.formId ?? r?.id ?? "").trim();
      if (rawId && rawIdR && rawId !== "-" && rawId === rawIdR) return true;
      return false;
    });

    return idx;
  } catch (e) {
    return -1;
  }
}

export function isRecordStrictlyEarlier(
  candidate?: any,
  target?: any,
  database?: CsvPermitRecord[]
): boolean {
  if (!candidate || !target) return false;
  try {
    if (isSamePermitRecord(candidate, target)) return false;

    const timeCandidate = extractRecordSubmissionTimeMs(candidate);
    const timeTarget = extractRecordSubmissionTimeMs(target);

    if (timeCandidate > 0 && timeTarget > 0 && timeCandidate !== timeTarget) {
      return timeCandidate < timeTarget;
    }

    const formIdCandidate = extractRecordNumericFormId(candidate);
    const formIdTarget = extractRecordNumericFormId(target);

    if (formIdCandidate > 0 && formIdTarget > 0 && formIdCandidate !== formIdTarget) {
      return formIdCandidate < formIdTarget;
    }

    if (formIdCandidate > 0 && formIdTarget === 0) {
      return true;
    }
    if (formIdTarget > 0 && formIdCandidate === 0) {
      return false;
    }

    if (timeCandidate > 0 && timeTarget === 0) {
      return true;
    }
    if (timeTarget > 0 && timeCandidate === 0) {
      return false;
    }

    if (database && database.length > 0) {
      const idxCandidate = getRecordDatasetIndex(candidate, database, formIdCandidate);
      const idxTarget = getRecordDatasetIndex(target, database, formIdTarget);

      if (idxCandidate !== -1 && idxTarget !== -1 && idxCandidate !== idxTarget) {
        const isDesc = database.length >= 2 && extractRecordNumericFormId(database[0]) > extractRecordNumericFormId(database[database.length - 1]);
        if (isDesc) {
          return idxCandidate > idxTarget;
        }
        return idxCandidate < idxTarget;
      }
    }

    return false;
  } catch (e) {
    return false;
  }
}

export function compareRecordsBySubmissionOrder(a?: any, b?: any, fallbackDateStr?: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  try {
    if (isSamePermitRecord(a, b)) return 0;
    if (isRecordStrictlyEarlier(a, b)) return -1;
    if (isRecordStrictlyEarlier(b, a)) return 1;
    return 0;
  } catch (e) {
    return 0;
  }
}

// ⭐ Memoization cache for duplicate & cancellation checks to guarantee O(1) performance
const blockedDuplicateCheckCache = new Map<string, boolean>();
const dbVrmIndexMapCache = new WeakMap<CsvPermitRecord[], Map<string, CsvPermitRecord[]>>();

export function clearDuplicateCheckCache(): void {
  blockedDuplicateCheckCache.clear();
}

export function checkIsBlockedDuplicate(
  record: { vrm?: string; validFrom?: string; validTo?: string; dateExpiry?: string; dateRequired?: string; id?: string | number; formId?: string | number; voucherCode?: string; createdAt?: string; startTime?: string; driverName?: string; isCancelled?: boolean; status?: string; voucherCodesText?: string; prePaidCode?: string; cancellationReason?: string },
  database: CsvPermitRecord[],
  refDateISO?: string,
  visited?: Set<string>
): boolean {
  if (!record || !record.vrm) return false;
  
  const cleanVrm = String(record.vrm).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleanVrm || cleanVrm === "PENDING" || cleanVrm === "-") return false;
  
  if (!database || database.length === 0) {
    return false;
  }

  // Genuine cancellation reasons that mean the permit should not be evaluated as duplicate
  if (
    record.cancellationReason === "MANUAL" ||
    record.cancellationReason === "BLOCKLIST" ||
    (record.cancellationReason === "EXPIRED" && isPermitExpiredBackdate(record, refDateISO)) ||
    isVrmSilentBlockedSync(record.vrm) ||
    (typeof record.status === "string" && record.status.trim().toUpperCase() === "BLOCKED")
  ) {
    return false;
  }

  const reqIsoX = parseDateToISO(record.dateRequired || record.validFrom || "") || 
                  parseDateToISO(record.startTime || record.createdAt || "") || 
                  refDateISO || getTodayISO();
  const cacheKey = `${String(record.formId ?? record.id ?? cleanVrm)}_${reqIsoX}_${cleanVrm}_${database.length}`;
  if (blockedDuplicateCheckCache.has(cacheKey)) {
    return blockedDuplicateCheckCache.get(cacheKey)!;
  }

  // Fast O(1) retrieval from pre-indexed VRM map
  let vrmIndexMap = dbVrmIndexMapCache.get(database);
  if (!vrmIndexMap) {
    vrmIndexMap = new Map<string, CsvPermitRecord[]>();
    for (let i = 0; i < database.length; i++) {
      const r = database[i];
      const rVrm = (r?.vrm || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (rVrm && rVrm !== "PENDING" && rVrm !== "-") {
        let list = vrmIndexMap.get(rVrm);
        if (!list) {
          list = [];
          vrmIndexMap.set(rVrm, list);
        }
        list.push(r);
      }
    }
    dbVrmIndexMapCache.set(database, vrmIndexMap);
  }

  const vrmRecords = vrmIndexMap.get(cleanVrm);
  if (!vrmRecords || vrmRecords.length === 0) {
    blockedDuplicateCheckCache.set(cacheKey, false);
    return false;
  }
  const containsCurrent = vrmRecords.some(r => isSamePermitRecord(r, record));
  if (containsCurrent && vrmRecords.length <= 1) {
    blockedDuplicateCheckCache.set(cacheKey, false);
    return false;
  }

  const strictlyEarlierRecords: CsvPermitRecord[] = [];

  for (const other of vrmRecords) {
    if (isSamePermitRecord(other, record)) continue;
    if (isRecordStrictlyEarlier(other, record, database)) {
      strictlyEarlierRecords.push(other);
    }
  }

  if (strictlyEarlierRecords.length === 0) {
    blockedDuplicateCheckCache.set(cacheKey, false);
    return false;
  }

  const reqTimeMsX = safeParseDateToTimestamp(reqIsoX) ?? 0;

  for (const earlier of strictlyEarlierRecords) {
    const earlierDateRequired = earlier?.dateRequired || earlier?.validFrom || "";
    const earlierRawRefDate = earlier?.completionTime || earlier?.startTime || earlier?.createdAt || earlier?.submissionDate;
    const earlierRefDate = earlierRawRefDate 
      ? (parseDateToISO(String(earlierRawRefDate)) || "") 
      : (parseDateToISO(earlierDateRequired) || refDateISO || "");

    // Ignore cancelled records when checking for existing permits, overlapping dates, or prior submissions:
    // A cancelled record must NEVER act as the "earlier active permit" in a duplicate comparison.
    const isEarlierCancelled = 
      earlier?.isCancelled === true ||
      (typeof earlier?.status === "string" && (earlier.status.trim().toUpperCase() === "CANCELLED" || earlier.status.trim().toLowerCase().includes("cancel"))) ||
      earlier?.voucherCode === "CANCELLED" ||
      earlier?.voucherCodesText === "CANCELLED" ||
      earlier?.prePaidCode === "CANCELLED" ||
      (typeof earlier?.voucherCode === "string" && earlier.voucherCode.trim().toUpperCase() === "CANCELLED") ||
      (typeof earlier?.voucherCodesText === "string" && earlier.voucherCodesText.trim().toUpperCase() === "CANCELLED") ||
      (typeof earlier?.prePaidCode === "string" && earlier.prePaidCode.trim().toUpperCase() === "CANCELLED") ||
      earlier?.cancellationReason === "DUPLICATE_VRM" ||
      earlier?.cancellationReason === "DUPLICATE" ||
      earlier?.cancellationReason === "BLOCKLIST" ||
      earlier?.cancellationReason === "MANUAL" ||
      earlier?.cancellationReason === "EXPIRED" ||
      Boolean(earlier?.cancellationReason);

    // Check if earlier record is genuinely invalid (cancelled, silent blocked on security blocklist, or expired date)
    const earlierIsInvalid = 
      isEarlierCancelled ||
      isVrmSilentBlockedSync(earlier?.vrm) ||
      (typeof earlier?.status === "string" && earlier.status.trim().toUpperCase() === "BLOCKED") ||
      isDateRequiredOutsideValidWindow(earlierDateRequired, earlierRefDate) ||
      isPermitExpiredBackdate(earlier, earlierRefDate);

    if (earlierIsInvalid) {
      continue;
    }

    // Also check if earlier record is itself a duplicate of an even earlier active record
    const currentVisited = visited ? new Set(visited) : new Set<string>();
    const recId = String(record.formId ?? record.id ?? cleanVrm);
    currentVisited.add(recId);

    const earlierId = String(earlier.formId ?? earlier.id ?? "");
    if (earlierId && !currentVisited.has(earlierId)) {
      currentVisited.add(earlierId);
      if (checkIsBlockedDuplicate(earlier, database, earlierRefDate, currentVisited)) {
        // Earlier record is itself a duplicate of an even earlier record, so it will be cancelled and does not block this permit
        continue;
      }
    }

    const earlierReqIso = parseDateToISO(earlier?.dateRequired || earlier?.validFrom || "") || 
                          parseDateToISO(earlier?.startTime || earlier?.createdAt || "") || 
                          refDateISO || getTodayISO();
    const reqToIsoX = record?.validTo ? parseDateToISO(record.validTo) : (record?.dateExpiry ? parseDateToISO(record.dateExpiry) : (reqIsoX ? addDaysSafe(reqIsoX, 6) : undefined));
    const earlierToIso = earlier?.validTo ? parseDateToISO(earlier.validTo) : (earlier?.dateExpiry ? parseDateToISO(earlier.dateExpiry) : (earlierReqIso ? addDaysSafe(earlierReqIso, 6) : undefined));
    if (reqIsoX && reqToIsoX && earlierReqIso && earlierToIso) {
      const startA = safeParseDateToTimestamp(reqIsoX) ?? 0;
      const endA = safeParseDateToTimestamp(reqToIsoX) ?? (startA + 6 * 86400000);
      const startB = safeParseDateToTimestamp(earlierReqIso) ?? 0;
      const endB = safeParseDateToTimestamp(earlierToIso) ?? (startB + 6 * 86400000);
      if (startA <= endB && startB <= endA) {
        blockedDuplicateCheckCache.set(cacheKey, true);
        return true;
      }
      // Rule 10: A record whose requested date range starts after the previous record's end date
      // must not be cancelled merely because the start dates are within 7 calendar days.
      continue;
    }

    const earlierReqTimeMs = safeParseDateToTimestamp(earlierReqIso) ?? 0;
    const diffDays = Math.round((reqTimeMsX - earlierReqTimeMs) / (1000 * 60 * 60 * 24));

    if (Math.abs(diffDays) < 7) {
      blockedDuplicateCheckCache.set(cacheKey, true);
      return true;
    }
  }

  blockedDuplicateCheckCache.set(cacheKey, false);
  return false;
}

function simpleStringHash(str: string): number {
  let hash = 0;
  if (!str || str.length === 0) return hash;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash;
}

export function isRecordCancelled(
  record: any,
  todayDateOrReference?: string,
  database?: CsvPermitRecord[]
): boolean {
  return isRecordCancelledCanonical(record, todayDateOrReference, database);
}

export function resolvePermitDate(record?: any): string {
  if (!record) return getTodayISO();
  const rawDate = record.processingDate ||
                  record.submissionDate ||
                  record.todayDate ||
                  record.startTime ||
                  record.completionTime ||
                  record.validFrom ||
                  record.dateRequired ||
                  record.createdAt;

  if (rawDate) {
    const range = parseDateRange(String(rawDate));
    if (range && range.startISO) {
      return range.startISO;
    }
    const iso = parseDateToISO(rawDate);
    if (iso) return iso;
  }
  return getTodayISO();
}

// ⭐ ============================================================
// ⭐ NEW: VRM VALIDATION FUNCTIONS
// ⭐ Add these at the end of the file
// ⭐ ============================================================

/**
 * Validate if a string is a valid UK VRM (Vehicle Registration Mark)
 * Valid formats:
 * - AA12AAA (2 letters, 2 numbers, 3 letters)
 * - AB12CDE (2 letters, 2 numbers, 3 letters)
 * - A123ABC (1 letter, 3 numbers, 3 letters) - older format
 */
export function isValidVRM(vrm: string): boolean {
  if (!vrm) return false;
  const clean = vrm.trim().toUpperCase().replace(/\s+/g, "");
  if (clean.length < 4) return false;
  
  // UK VRM patterns
  const ukPattern = /^[A-Z]{2}[0-9]{2}[A-Z]{3}$/;   // AA12AAA
  const oldPattern = /^[A-Z][0-9]{3}[A-Z]{3}$/;     // A123ABC
  
  return ukPattern.test(clean) || oldPattern.test(clean);
}

/**
 * Detect if a string is likely a driver name (not a VRM)
 * Used to catch cases where users enter their name in the VRM field
 */
export function isLikelyDriverName(text: string): boolean {
  if (!text) return false;
  const s = text.trim().toUpperCase().replace(/\s+/g, "");
  
  // If it contains numbers, it's probably a VRM
  if (/\d/.test(s)) return false;
  
  // If it's all letters and longer than 7 characters, it's probably a name
  if (/^[A-Z]+$/.test(s) && s.length > 7) return true;
  
  // Common name patterns
  const commonNames = ["JOHN", "PETER", "DAVID", "SARAH", "ALASTAIR", "ABDULLAH", "MOHAMMED", "MARY", "JAMES", "ROBERT", "MICHAEL", "WILLIAM"];
  if (commonNames.some(name => s.includes(name))) return true;
  
  return false;
}

/**
 * Clean VRM field - if it looks like a name, move it to driver name field
 * Returns { vrm, driverName } with corrected values
 */
export function cleanVrm(value: string, driverName: string): { vrm: string; driverName: string } {
  const raw = (value || "").trim().toUpperCase();
  
  if (!raw) return { vrm: "", driverName };
  
  // If VRM looks like a name, move it to driver name
  if (isLikelyDriverName(raw)) {
    const newDriverName = driverName ? `${driverName} ${toTitleCase(raw)}` : toTitleCase(raw);
    return { vrm: "PENDING", driverName: newDriverName };
  }
  
  // Clean VRM: remove spaces, keep only valid characters
  const cleanVrm = raw.replace(/[^A-Z0-9]/g, "");
  return { vrm: cleanVrm, driverName };
}

/**
 * Check if a VRM is pending (needs correction)
 */
export function isVrmPending(vrm: string): boolean {
  return vrm === "PENDING" || vrm === "PENDING_CORRECTION";
}