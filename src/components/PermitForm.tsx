import React, { useState, useMemo } from "react";
import { PermitData, HOSPITAL_SITES } from "../types";
import { 
  CsvPermitRecord, 
  parseDateToISO, 
  getTodayISO,
  addDays, 
  ParsedVoucherData, 
  getMatchingPermits, 
  getUnusedVouchersForDate, 
  getSpreadsheetMatchingAssignedCodes, 
  checkIsBlockedDuplicate, 
  resolvePermitDate,
  getRequestedPermitDateISO,
  getVoucherDateISO,
  extractRecordNumericFormId,
  isSamePermitRecord,
  cleanVoucherCodeValue,
  isVoucherCodeMatch,
  isVoucherInValidityPeriod,
  isRecordCancelledCanonical as isCancelled
} from "../utils/csvParser";
import { 
  Building2, 
  User, 
  Car, 
  Calendar, 
  Network, 
  CreditCard,
  Phone,
  Mail,
  Key,
  Ticket,
  ChevronDown
} from "lucide-react";
import { isVrmSilentBlockedSync } from "../lib/blocklist";
import { getSelectableActiveDateCodes, buildAssignedCodeSet } from "../utils/voucherValidation";

// Helper to format string to Title Case (capitalize each word)
function toTitleCase(str: string): string {
  if (!str || str === "-") return str;
  return str
    .toLowerCase()
    .replace(/(?:^|\s|-)\S/g, (char) => char.toUpperCase());
}

// Helper to format date to UK standard DD/MM/YYYY
function formatDate(d: string): string {
  if (!d) return "";
  const iso = parseDateToISO(d);
  if (!iso) return d;
  const parts = iso.split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : d;
}

interface PermitFormProps {
  data: PermitData;
  database: CsvPermitRecord[];
  vouchersDatabase?: ParsedVoucherData[];
  dispatchedKeys?: string[];
  unsentKeys?: string[];
  dispatchBy?: {[key: string]: string};
  onChange: (updates: Partial<PermitData>) => void;
  onClear?: () => void;
}

export function PermitForm({ 
  data, 
  database, 
  vouchersDatabase = [], 
  dispatchedKeys = [], 
  unsentKeys = [],
  dispatchBy = {},
  onChange
}: PermitFormProps) {
  const [assignmentError, setAssignmentError] = useState<string | null>(null);

  // Distinct wards for the dropdown
  const availableWards = useMemo(() => {
    const set = new Set<string>();
    database.forEach(r => {
      if (r.ward) set.add(toTitleCase(r.ward));
    });
    if (set.size === 0) {
      return ["Acorn Ward", "Mulberry Ward", "ICU", "Larch Antenatal Ward", "Antenatal Ward", "CDS", "Birth Centre", "Acacia Ward", "Larch Postnatal Ward"];
    }
    return Array.from(set);
  }, [database]);

  // Target ISO for the permit being viewed/edited
  const targetIso = useMemo(() => {
    // 1. Highest priority: The selected permit record's requested date
    const permitIso = getRequestedPermitDateISO(data);
    if (permitIso && /^\d{4}-\d{2}-\d{2}$/.test(permitIso)) {
      return permitIso;
    }
    // 2. Fallback: form's todayDate / processing date
    const processingIso = data.todayDate ? parseDateToISO(String(data.todayDate)) : "";
    if (processingIso && /^\d{4}-\d{2}-\d{2}$/.test(processingIso)) {
      return processingIso;
    }
    return getTodayISO();
  }, [data.validFrom, data.dateRequired, data.startTime, data.createdAt, data.todayDate]);

  // Matching permits for the active date
  const matchingPermits = useMemo(() => {
    if (!targetIso) return [];
    return getMatchingPermits(database, targetIso);
  }, [database, targetIso]);

  // The form only ever holds ONE mutable, shared editable state (`data`), which can
  // carry stale fields (e.g. dateRequired) left over from a previously-loaded record.
  // The Permit Table never has this problem because it reads each row's own record
  // straight from the database. To keep both views in agreement, resolve the actual
  // database record for whatever permit is currently loaded and use ITS fields for
  // cancellation/duplicate checks — not the form's own editable state.
  const canonicalRecord = useMemo(() => {
    if (!database || database.length === 0) return data;
    const numId = extractRecordNumericFormId(data);
    const matched = database.find(
      r => isSamePermitRecord(r, data) || (numId > 0 && extractRecordNumericFormId(r) === numId)
    );
    return matched || data;
  }, [data, database]);

  // Precomputed assigned set for performance (keyed on database, dispatchedKeys, and canonicalRecord id)
  const assignedSetForPermit = useMemo(() => {
    return buildAssignedCodeSet(database, canonicalRecord, dispatchedKeys);
  }, [database, canonicalRecord, dispatchedKeys]);

  // Unused vouchers computation using shared getSelectableActiveDateCodes and precomputedAssignedSet
  const unusedVouchersForDay = useMemo<ParsedVoucherData[]>(() => {
    if (!targetIso) return [];
    return getSelectableActiveDateCodes({
      vouchersDatabase,
      database,
      permitDateRequired: targetIso,
      permitDateExpiry: data.validTo || addDays(targetIso, 6),
      currentRecord: canonicalRecord,
      extraExcludedCodes: [data.voucherCodesText, data.voucherCode, data.prePaidCode],
      precomputedAssignedSet: assignedSetForPermit,
      dispatchedKeys
    });
  }, [vouchersDatabase, database, targetIso, data, canonicalRecord, assignedSetForPermit, dispatchedKeys]);

  const hasValidVoucherCode = useMemo(() => {
    const code = cleanVoucherCodeValue(String(data.voucherCodesText || "")).toUpperCase();
    return Boolean(code && code !== "-" && code !== "CANCELLED" && code !== "PENDING" && code !== "N/A");
  }, [data.voucherCodesText]);

  const isSilentBlocked = useMemo(() => {
    return isVrmSilentBlockedSync(data.vrm);
  }, [data.vrm]);

  const dateWarning = useMemo(() => {
    if (data.validFrom && data.validTo) {
      return new Date(data.validTo) < new Date(data.validFrom);
    }
    return false;
  }, [data.validFrom, data.validTo]);

  // handleSelectMatchingPermit
  const handleSelectMatchingPermit = (record: CsvPermitRecord) => {
    const fromISO = parseDateToISO(record.dateRequired);
    const toISO = addDays(fromISO, 6);
    
    onChange({
      ...data,
      id: record.id,
      formId: record.formId || record.id,
      site: record.hospital || data.site,
      name: record.driverName ? toTitleCase(record.driverName) : (data.name || ""),
      vrm: record.vrm ? record.vrm.toUpperCase() : (data.vrm || ""),
      ward: record.ward ? toTitleCase(record.ward) : (data.ward || ""),
      validFrom: fromISO || data.validFrom,
      validTo: toISO || data.validTo,
      todayDate: data.todayDate,
      dateRequired: record.dateRequired || data.todayDate,
      phone: record.phone || "",
      email: (record.email || "").toLowerCase(),
      voucherCodesText: record.voucherCode || "-",
      startTime: record.startTime,
      createdAt: record.createdAt,
      isResend: false,
      emailType: "SEND_CONCESSION",
      emailTemplate: "new"
    });
  };

  const formattedProcessingDate = data.todayDate ? formatDate(data.todayDate) : "07/07/2026";
  const formattedValidFrom = data.validFrom ? formatDate(data.validFrom) : formattedProcessingDate;
  const formattedValidTo = data.validTo ? formatDate(data.validTo) : (data.todayDate ? formatDate(addDays(data.todayDate, 6)) : "13/07/2026");

  // Common class strings for inputs and selects: 12px, font-weight: 400 (regular, not bold), compact styling
  const inputClass = "permit-form-input w-full h-8 text-[12px] font-normal rounded-md px-2.5 py-1 focus:outline-none transition placeholder:text-[12px] placeholder:font-normal";
  const selectClass = "permit-form-select w-full h-8 text-[12px] font-normal rounded-md px-2.5 py-1 appearance-none pr-7 focus:outline-none transition cursor-pointer";

  return (
    <section className="permit-form-shell w-full h-full rounded-xl p-3 md:p-3.5 flex flex-col gap-2.5">
      
      {/* 1. Section Header */}
      <div className="flex items-center justify-between pb-2 border-b border-[rgba(113,163,255,0.15)]">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-[#1677FF]/15 border border-[#1677FF]/30 flex items-center justify-center text-[#1677FF] shadow-sm">
            <User className="w-3.5 h-3.5" />
          </div>
          <div>
            <h2 className="text-[14px] font-medium text-white tracking-tight leading-none">
              Configure Permit &amp; Driver Details
            </h2>
          </div>
        </div>
      </div>

      {/* 2. Form Layout - Row 1 (4 columns) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {/* Card Main Title */}
        <div className="flex flex-col">
          <label htmlFor="cardTitle" className="text-[10px] font-medium uppercase tracking-[0.5px] text-[#B7D4FF] flex items-center gap-1.5 mb-1">
            <CreditCard className="w-3 h-3 text-[#1677FF]" />
            <span>Card Main Title</span>
          </label>
          <input
            id="cardTitle"
            type="text"
            value={data.title || "Patient & Visitor Concessions"}
            onChange={e => onChange({ title: e.target.value })}
            className={inputClass}
            placeholder="Patient & Visitor Concessions"
          />
        </div>

        {/* Processing Date */}
        <div className="flex flex-col">
          <label htmlFor="processingDate" className="text-[10px] font-medium uppercase tracking-[0.5px] text-[#B7D4FF] flex items-center gap-1.5 mb-1">
            <Calendar className="w-3 h-3 text-[#1677FF]" />
            <span>Processing Date</span>
          </label>
          <div className="relative">
            <input
              id="processingDate"
              type="date"
              value={data.todayDate || ""}
              onChange={e => {
                const newDate = e.target.value;
                onChange({
                  todayDate: newDate,
                  validFrom: newDate,
                  validTo: newDate ? addDays(newDate, 6) : data.validTo,
                  dateRequired: newDate
                });
              }}
              onClick={e => { try { e.currentTarget.showPicker(); } catch {} }}
              className={`${inputClass} cursor-pointer`}
            />
          </div>
        </div>

        {/* Valid From */}
        <div className="flex flex-col">
          <label htmlFor="validFrom" className="text-[10px] font-medium uppercase tracking-[0.5px] text-[#B7D4FF] flex items-center gap-1.5 mb-1">
            <Calendar className="w-3 h-3 text-[#1677FF]" />
            <span>Valid From</span>
          </label>
          <input
            id="validFrom"
            type="text"
            readOnly
            value={formattedValidFrom}
            className={`${inputClass} opacity-90 focus:outline-none`}
          />
        </div>

        {/* Valid To */}
        <div className="flex flex-col">
          <label htmlFor="validTo" className="text-[10px] font-medium uppercase tracking-[0.5px] text-[#B7D4FF] flex items-center gap-1.5 mb-1">
            <Calendar className="w-3 h-3 text-[#1677FF]" />
            <span>Valid To</span>
          </label>
          <input
            id="validTo"
            type="text"
            readOnly
            value={formattedValidTo}
            className={`${inputClass} opacity-90 focus:outline-none ${
              dateWarning ? "border-rose-500 text-rose-300" : ""
            }`}
          />
        </div>
      </div>

      {dateWarning && (
        <div className="p-2 rounded-lg bg-rose-950/40 border border-rose-500/50 text-rose-300 text-[11px] flex items-center gap-2">
          <span>⚠ Warning: Expiry date is set before the valid start date.</span>
        </div>
      )}

      {/* 3. Form Layout - Row 2 (4 columns) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {/* Hospital Site */}
        <div className="flex flex-col">
          <label htmlFor="hospitalSelect" className="text-[10px] font-medium uppercase tracking-[0.5px] text-[#B7D4FF] flex items-center gap-1.5 mb-1">
            <Building2 className="w-3 h-3 text-[#1677FF]" />
            <span>Hospital Site</span>
          </label>
          <div className="relative">
            <select
              id="hospitalSelect"
              value={data.site || "Whipps Cross Hospital"}
              onChange={e => onChange({ site: e.target.value })}
              className={selectClass}
            >
              <option value="" className="bg-[#041320] text-white text-[12px] font-normal">— Select Site —</option>
              {HOSPITAL_SITES.map(site => (
                <option key={site} value={site} className="bg-[#041320] text-white text-[12px] font-normal">{site}</option>
              ))}
            </select>
            <ChevronDown className="w-3 h-3 text-[#B7D4FF] absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
        </div>

        {/* Ward / Department */}
        <div className="flex flex-col">
          <label htmlFor="wardSelect" className="text-[10px] font-medium uppercase tracking-[0.5px] text-[#B7D4FF] flex items-center gap-1.5 mb-1">
            <Network className="w-3 h-3 text-[#1677FF]" />
            <span>Ward / Department</span>
          </label>
          <div className="relative">
            <select
              id="wardSelect"
              value={data.ward || "Acorn Ward"}
              onChange={e => onChange({ ward: e.target.value })}
              className={selectClass}
            >
              <option value="" className="bg-[#041320] text-white text-[12px] font-normal">— Select Ward —</option>
              {availableWards.map(w => (
                <option key={w} value={w} className="bg-[#041320] text-white text-[12px] font-normal">{w}</option>
              ))}
              {data.ward && !availableWards.includes(data.ward) && (
                <option value={data.ward} className="bg-[#041320] text-white text-[12px] font-normal">{data.ward}</option>
              )}
            </select>
            <ChevronDown className="w-3 h-3 text-[#B7D4FF] absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
        </div>

        {/* Driver's Name */}
        <div className="flex flex-col">
          <label htmlFor="driverName" className="text-[10px] font-medium uppercase tracking-[0.5px] text-[#B7D4FF] flex items-center gap-1.5 mb-1">
            <User className="w-3 h-3 text-[#1677FF]" />
            <span>Driver's Name</span>
          </label>
          <input
            id="driverName"
            type="text"
            value={data.name || ""}
            onChange={e => onChange({ name: e.target.value })}
            placeholder="e.g. Sherry Moran"
            className={inputClass}
          />
        </div>

        {/* VRM / Number Plate */}
        <div className="flex flex-col">
          <label htmlFor="vrm" className="text-[10px] font-medium uppercase tracking-[0.5px] text-[#B7D4FF] flex items-center gap-1.5 mb-1">
            <Car className="w-3 h-3 text-[#1677FF]" />
            <span>VRM / Number Plate</span>
          </label>
          <input
            id="vrm"
            type="text"
            value={data.vrm || ""}
            onChange={e => onChange({ vrm: e.target.value.toUpperCase() })}
            placeholder="E.G. FN15VKS"
            className={`${inputClass} uppercase`}
          />
          {(!data.vrm || String(data.vrm).trim() === "") && (
            <span className="text-amber-400/90 text-[10px] mt-0.5 font-normal select-none">
              Awaiting plate number input
            </span>
          )}
        </div>
      </div>

      {/* 4. Form Layout - Row 3 (Phone & Email) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {/* Phone Number */}
        <div className="flex flex-col">
          <label htmlFor="phoneNumber" className="text-[10px] font-medium uppercase tracking-[0.5px] text-[#B7D4FF] flex items-center gap-1.5 mb-1">
            <Phone className="w-3 h-3 text-[#1677FF]" />
            <span>Phone Number</span>
          </label>
          <input
            id="phoneNumber"
            type="text"
            value={data.phone || ""}
            onChange={e => onChange({ phone: e.target.value })}
            placeholder="e.g. 07700 900077"
            className={inputClass}
          />
        </div>

        {/* Email Address */}
        <div className="flex flex-col">
          <label htmlFor="emailAddress" className="text-[10px] font-medium uppercase tracking-[0.5px] text-[#B7D4FF] flex items-center gap-1.5 mb-1">
            <Mail className="w-3 h-3 text-[#1677FF]" />
            <span>Email Address</span>
          </label>
          <input
            id="emailAddress"
            type="email"
            value={data.email || ""}
            onChange={e => onChange({ email: e.target.value.toLowerCase() })}
            placeholder="driver@example.com"
            className={inputClass}
          />
        </div>
      </div>

      {/* 5. Form Layout - Row 4: Standalone Code Display Box (Left 50%) and Active Date Codes Dropdown (Right 50%) */}
      <div className="grid grid-cols-2 gap-3 md:gap-4 w-full items-center">
        {/* Left Half (50% Width): Standalone Code Display Box */}
        <div className="w-full">
          <input
            type="text"
            value={data.voucherCodesText || (isSilentBlocked ? "BLOCKED" : "")}
            onChange={(e) =>
              onChange({
                voucherCodesText: e.target.value,
                status: "Pending"
              })
            }
            className={`w-full h-9 px-3 py-1.5 border rounded-md text-xs font-extrabold focus:outline-none transition-all ${
              !hasValidVoucherCode && (isSilentBlocked || isCancelled(canonicalRecord, data.todayDate, database) ||
              data.voucherCodesText === "-" || data.voucherCodesText === "CANCELLED" || data.voucherCodesText === "Cancelled" || data.voucherCodesText === "BLOCKED")
                ? "border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 font-mono"
                : "border-gray-300 dark:border-slate-800 bg-white dark:bg-slate-950 text-gray-800 dark:text-slate-100 focus:border-[#005EB8] dark:focus:border-blue-500 font-mono"
            }`}
            placeholder="e.g. CON9012JXM"
          />
        </div>

        {/* Right Half (50% Width): Label + Dropdown Select */}
        {vouchersDatabase && vouchersDatabase.length > 0 ? (
          <div className="flex flex-col gap-1 w-full">
            <div className="flex items-center gap-2 w-full">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap shrink-0">
                Active Date Codes ({unusedVouchersForDay.length}):
              </label>

              <select
                value={unusedVouchersForDay.some(v => v.code === data.voucherCodesText) ? data.voucherCodesText : ""}
                onChange={(e) => {
                  const selectedCode = cleanVoucherCodeValue(e.target.value).toUpperCase();
                  if (!selectedCode || selectedCode === "-" || selectedCode === "CANCELLED") {
                    return;
                  }

                  if (assignedSetForPermit.has(selectedCode)) {
                    setAssignmentError(`${selectedCode} is no longer available`);
                    setTimeout(() => setAssignmentError(null), 4000);
                    return;
                  }
                  setAssignmentError(null);

                  onChange({
                    id: data.id,
                    formId: data.formId,
                    vrm: data.vrm,
                    validFrom: data.validFrom,
                    dateRequired: data.dateRequired,
                    todayDate: data.todayDate,
                    voucherCodesText: selectedCode,
                    replacementCode: selectedCode,
                    status: "Pending",
                    emailType: "RESEND_CONCESSION",
                    isResend: true,
                    emailTemplate: "replacement"
                  });
                }}
                disabled={unusedVouchersForDay.length === 0}
                className={`flex-1 min-w-[180px] w-full h-9 px-3 py-1.5 border rounded-md text-xs font-mono font-extrabold focus:outline-none transition-all ${
                  unusedVouchersForDay.length > 0
                    ? "border-gray-300 dark:border-slate-700 focus:border-[#005EB8] dark:focus:border-blue-500 bg-emerald-50/80 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-200 cursor-pointer"
                    : "border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900 text-gray-400 dark:text-slate-500 cursor-not-allowed font-normal"
                }`}
              >
                <option value="" disabled className="font-mono font-normal">
                  Replacing...
                </option>
                {unusedVouchersForDay.map((v, index) => (
                  <option
                    key={`voucher_${v.code}_${index}`}
                    value={v.code}
                    className="font-mono font-extrabold text-gray-800 dark:bg-slate-900 dark:text-slate-100"
                  >
                    {v.code}
                  </option>
                ))}
              </select>
            </div>
            {assignmentError && (
              <div className="text-xs text-rose-600 dark:text-rose-400 font-medium">
                {assignmentError}
              </div>
            )}
          </div>
        ) : null}
      </div>

    </section>
  );
}
