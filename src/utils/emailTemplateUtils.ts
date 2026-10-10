import { 
  formatDate, 
  parseDateToISO, 
  addDays, 
  toTitleCase,
  getTodayISO,
  checkIsBlockedDuplicate,
  isRecordCancelled,
  isPermitExpiredBackdate
} from "./csvParser";

export type CancellationReason = 'future' | 'expired' | 'duplicate';

export interface EmailTemplateParams {
  vrm?: string;
  driverName?: string;
  duration?: string;
  validFrom?: string;
  validTo?: string;
  todayDate?: string;
  dateRequired?: string;
  activePermitExpiry?: string;
  reapplyDate?: string;
  currentExpiryDate?: string;
  earliestRenewalDate?: string;
  reason?: CancellationReason;
  cancellationReason?: string;
  trackingPixelUrl?: string;
  trackingId?: string;
}

export interface EmailContentResult {
  subject: string;
  plainText: string;
  htmlText: string;
}

export const NHS_SUPPORT_EMAIL = "parkingadminbh.bartshealth@nhs.net";

/**
 * Automatically resolves the cancellation details (reason: duplicate/expired/future,
 * currentExpiryDate, earliestRenewalDate) for a permit record based on the database.
 */
export function resolveCancellationDetails(
  record?: { 
    vrm?: string; 
    name?: string; 
    driverName?: string; 
    validFrom?: string; 
    dateRequired?: string; 
    todayDate?: string; 
    id?: string | number; 
    formId?: string | number; 
    isCancelled?: boolean; 
    voucherCode?: string;
    status?: string;
    isDispatched?: boolean;
    startTime?: string;
    start_time?: string;
    createdAt?: string;
    created_at?: string;
    completionTime?: string;
    completion_time?: string;
    submissionDate?: string;
    validTo?: string;
    cancellationReason?: "DUPLICATE_VRM" | "BLOCKLIST" | "EXPIRED" | "MANUAL" | string;
  },
  database?: any[],
  refDateStr?: string
): {
  reason: CancellationReason;
  currentExpiryDate: string;
  earliestRenewalDate: string;
} {
  if (!record) {
    return { reason: 'future', currentExpiryDate: '', earliestRenewalDate: '' };
  }

  // Submission / processing reference date resolution:
  const rawSubTime = record.completionTime || (record as any).completion_time || record.startTime || (record as any).start_time || record.createdAt || (record as any).created_at || (record as any).submissionDate;
  let subISO = "";
  if (rawSubTime) {
    subISO = parseDateToISO(String(rawSubTime)) || "";
  }
  let refDateISO = subISO;
  if (!refDateISO && refDateStr) {
    refDateISO = parseDateToISO(refDateStr) || "";
  }
  if (!refDateISO && record.todayDate) {
    const tdISO = parseDateToISO(record.todayDate) || "";
    if (tdISO && tdISO !== parseDateToISO(record.validFrom || record.dateRequired || "")) {
      refDateISO = tdISO;
    }
  }
  if (!refDateISO) {
    refDateISO = getTodayISO();
  }

  const cleanVrm = (record.vrm || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const canonicalReason = String(record.cancellationReason || "").trim().toUpperCase();

  // Helper to extract active permit details for duplicate email presentation
  const getActivePermitDates = (): { currentExpiryDate: string; earliestRenewalDate: string; activePermitFound: boolean } => {
    let currentExpiryDate = "";
    let earliestRenewalDate = "";
    let activePermitFound = false;

    if (cleanVrm && cleanVrm !== "PENDING" && cleanVrm !== "-" && database && database.length > 0) {
      const cleanRecordId = (val: any) => String(val || "").replace(/^#/, "").trim();
      const recFormId = cleanRecordId(record.formId ?? record.id);

      const matchingRecords = database.filter(r => {
        const rVrm = (r.vrm || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (rVrm !== cleanVrm) return false;
        const rFormId = cleanRecordId(r.formId ?? r.id);
        if (recFormId && rFormId && recFormId === rFormId) return false;
        return true;
      });

      if (matchingRecords.length > 0) {
        const activeMatches = matchingRecords.filter(r => {
          if (r.isCancelled === true || String(r.status || '').trim().toUpperCase() === 'CANCELLED' || String(r.status || '').toLowerCase().includes('cancel')) return false;
          if (r.cancellationReason && r.cancellationReason !== '') return false;
          if (r.voucherCode === 'CANCELLED' || r.voucherCode === '-') {
            if (r.status !== 'ACTIVE' && r.status !== 'sent' && r.status !== 'SENT' && !r.isDispatched) return false;
          }
          const isActiveStatus = (r.status === 'sent' || r.status === 'SENT' || r.isDispatched === true || r.status === 'ACTIVE' ||
            (r.voucherCode && r.voucherCode !== '-' && r.voucherCode !== 'CANCELLED' && r.voucherCode !== 'Cancelled'));
          if (!isActiveStatus) return false;

          // If the permit expired 7 or more days before reference date, it is completely expired in the past and cannot be an active permit
          let rExpiry = "";
          const rReq = parseDateToISO(r.dateRequired || "");
          const rTo = parseDateToISO(r.validTo || "");
          const rFrom = parseDateToISO(r.validFrom || "");
          const rExp = parseDateToISO(r.dateExpiry || "");
          if (rReq) {
            const calc = addDays(rReq, 6);
            rExpiry = (rTo && rTo > calc) ? rTo : calc;
          } else if (rTo) {
            rExpiry = rTo;
          } else if (rFrom) {
            rExpiry = addDays(rFrom, 6);
          } else if (rExp) {
            rExpiry = rExp;
          }
          if (rExpiry && refDateISO) {
            const [ey, em, ed] = rExpiry.split("-").map(Number);
            const [ry, rm, rd] = refDateISO.split("-").map(Number);
            const diffDays = Math.floor((new Date(ey, em - 1, ed).getTime() - new Date(ry, rm - 1, rd).getTime()) / (1000 * 60 * 60 * 24));
            if (diffDays <= -7) return false;
          }

          return true;
        });

        const activePermit = activeMatches.length > 0 ? activeMatches[0] : undefined;
        if (activeMatches.length > 0 && activePermit) {
          activePermitFound = true;
          let expiryIso = "";
          const activeReqIso = parseDateToISO(activePermit.dateRequired || "");
          const activeValidToIso = parseDateToISO(activePermit.validTo || "");
          const activeValidFromIso = parseDateToISO(activePermit.validFrom || "");
          const activeExpiryIso = parseDateToISO(activePermit.dateExpiry || "");

          if (activeReqIso) {
            const calculatedExpiry = addDays(activeReqIso, 6);
            expiryIso = (activeValidToIso && activeValidToIso > calculatedExpiry) ? activeValidToIso : calculatedExpiry;
          } else if (activeValidToIso) {
            expiryIso = activeValidToIso;
          } else if (activeValidFromIso) {
            expiryIso = addDays(activeValidFromIso, 6);
          } else if (activeExpiryIso) {
            expiryIso = activeExpiryIso;
          } else {
            const fallbackStart = parseDateToISO(activePermit.startTime || activePermit.createdAt || "");
            if (fallbackStart) {
              expiryIso = addDays(fallbackStart, 6);
            }
          }

          if (expiryIso) {
            currentExpiryDate = formatDate(expiryIso);
            const renewalIso = addDays(expiryIso, 1);
            if (renewalIso) {
              earliestRenewalDate = formatDate(renewalIso);
            }
          }
        }
      }
    }

    return { currentExpiryDate, earliestRenewalDate, activePermitFound };
  };

  const isBackdate = isPermitExpiredBackdate(record, refDateISO);
  const validFromStr = record.validFrom || record.dateRequired || "";
  const validFromISO = parseDateToISO(validFromStr);
  let daysDiff = 0;
  if (validFromISO && refDateISO) {
    const [vy, vm, vd] = validFromISO.split("-").map(Number);
    const [ry, rm, rd] = refDateISO.split("-").map(Number);
    daysDiff = Math.floor((new Date(vy, vm - 1, vd).getTime() - new Date(ry, rm - 1, rd).getTime()) / (1000 * 60 * 60 * 24));
  }

  // 1. Expired validity period: explicit EXPIRED canonical reason, backdate where 7-day validity ended, or date requested 7+ days in past
  if (canonicalReason === "EXPIRED" || isBackdate || (validFromISO && daysDiff <= -7)) {
    return {
      reason: 'expired',
      currentExpiryDate: '',
      earliestRenewalDate: ''
    };
  }

  const { currentExpiryDate, earliestRenewalDate, activePermitFound } = getActivePermitDates();

  // 2. Explicit canonical duplicate cancellation reason takes precedence over future check for duplicates
  if (canonicalReason === "DUPLICATE_VRM" || canonicalReason === "DUPLICATE") {
    return {
      reason: 'duplicate',
      currentExpiryDate,
      earliestRenewalDate
    };
  }

  // 3. Check if an active permit for this VRM exists in the database
  if (cleanVrm && cleanVrm !== "PENDING" && cleanVrm !== "-" && database && database.length > 0) {
    if (activePermitFound || checkIsBlockedDuplicate(record, database, refDateISO)) {
      return {
        reason: 'duplicate',
        currentExpiryDate,
        earliestRenewalDate
      };
    }
  }

  // 4. Future concession requested 2+ days in advance
  if (canonicalReason === "FUTURE" || (validFromISO && daysDiff > 1)) {
    return {
      reason: 'future',
      currentExpiryDate: '',
      earliestRenewalDate: ''
    };
  }

  // 5. Fallback within normal window (-6 to +1 days)
  if (validFromISO) {
    if (cleanVrm && cleanVrm !== "PENDING" && cleanVrm !== "-" && database && database.length > 0) {
      const cleanRecordId = (val: any) => String(val || "").replace(/^#/, "").trim();
      const recFormId = cleanRecordId(record.formId ?? record.id);
      const hasAnySameVrm = database.some(r => {
        const rVrm = (r.vrm || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (rVrm !== cleanVrm) return false;
        const rFormId = cleanRecordId(r.formId ?? r.id);
        return !(recFormId && rFormId && recFormId === rFormId);
      });
      if (hasAnySameVrm) {
        return {
          reason: 'duplicate',
          currentExpiryDate,
          earliestRenewalDate
        };
      }
    }

    return {
      reason: 'expired',
      currentExpiryDate: '',
      earliestRenewalDate: ''
    };
  }

  return {
    reason: 'expired',
    currentExpiryDate: '',
    earliestRenewalDate: ''
  };
}

/**
 * Normalizes VRM for email display (Upper-case, e.g., FY21CVX)
 */
export function formatVrmForEmail(vrm?: string | null): string {
  if (!vrm || vrm.trim() === "" || vrm.trim() === "-") {
    return "[VRM]";
  }
  return vrm.trim().toUpperCase().replace(/\s+/g, "");
}

/**
 * Normalizes driver name for email display (Title-case, e.g., Shakil Uddin)
 */
export function formatDriverNameForEmail(name?: string | null): string {
  if (!name || name.trim() === "" || name.trim() === "-") {
    return "Driver";
  }
  return toTitleCase(name.trim());
}

/**
 * Derives formatted validFrom and validExpiry date strings (DD/MM/YYYY)
 */
export function deriveDateRangeForEmail(params: EmailTemplateParams): {
  validFrom: string;
  validExpiry: string;
} {
  const rawFrom = params.validFrom || params.dateRequired || params.todayDate || "";
  const rawFromIso = parseDateToISO(rawFrom);

  const rawTo = params.validTo || "";
  const rawToIso = parseDateToISO(rawTo);

  let formattedFrom = "[Valid From]";
  if (rawFrom) {
    const f = formatDate(rawFrom);
    if (f && f !== "-") formattedFrom = f;
  }

  let formattedExpiry = "[Valid Expiry]";
  if (rawTo) {
    const f = formatDate(rawTo);
    if (f && f !== "-") formattedExpiry = f;
  } else if (rawFromIso) {
    const calculatedExpiryIso = addDays(rawFromIso, 6);
    if (calculatedExpiryIso) {
      formattedExpiry = formatDate(calculatedExpiryIso);
    }
  }

  return {
    validFrom: formattedFrom,
    validExpiry: formattedExpiry,
  };
}

/**
 * Template 1: Send Concession QR Code
 */
export function getSendEmailContent(params: EmailTemplateParams): EmailContentResult {
  const vrm = formatVrmForEmail(params.vrm);
  const driverName = formatDriverNameForEmail(params.driverName);
  const duration = params.duration || "7 days";
  const { validFrom, validExpiry } = deriveDateRangeForEmail(params);

  const subject = `Your QR Code Credentials - ${vrm}`;

  const plainText = `
Dear ${driverName},

Please find attached your concession QR code.

On your first day of parking, please take the QR code to the pay machine, press Concession, and enter vehicle registration number ${vrm}.

The machine will then ask you to scan a blue badge or concession. Please scan your QR code at this point.

Your concession will allow you to park for ${duration}, from ${validFrom} to ${validExpiry}.

Please note that concession payments are non-refundable.

If you have any queries, please contact: ${NHS_SUPPORT_EMAIL}

Kind regards,
Barts Health NHS Trust
Car Parking Services Team`;

  const htmlText = `<div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #000000; line-height: 1.35;">
<br/>
Dear ${driverName},<br/><br/>
Please find attached your concession QR code.<br/><br/>
On your first day of parking, please take the QR code to the pay machine, press Concession, and enter vehicle registration number <strong>${vrm}</strong>.<br/><br/>
The machine will then ask you to scan a blue badge or concession. Please scan your QR code at this point.<br/><br/>
Your concession will allow you to park for ${duration}, from ${validFrom} to ${validExpiry}.<br/><br/>
Please note that concession payments are non-refundable.<br/><br/>
If you have any queries, please contact: <a href="mailto:${NHS_SUPPORT_EMAIL}" style="color: #005EB8; text-decoration: underline;">${NHS_SUPPORT_EMAIL}</a><br/><br/>
Kind regards,<br/>
Barts Health NHS Trust<br/>
Car Parking Services Team
</div>`;

  return { subject, plainText, htmlText };
}

/**
 * Template 2: Replacement / Resent Concession QR Code (RESEND_CONCESSION)
 */
export function getReplacementEmailContent(params: EmailTemplateParams): EmailContentResult {
  const vrm = formatVrmForEmail(params.vrm);
  const driverName = formatDriverNameForEmail(params.driverName);
  const duration = params.duration || "7 days";
  const { validFrom, validExpiry } = deriveDateRangeForEmail(params);

  const subject = `Replacement Parking Concession – ${vrm}`;

  const plainText = `
Dear ${driverName},

Please find attached your replacement concession QR code. We apologise for any inconvenience caused by the previous code.

Please use this replacement QR code instead of your previous QR code.

On your next visit, please take the replacement QR code to the pay machine, press Concession, and enter vehicle registration number ${vrm}.

The machine will then ask you to scan a blue badge or concession. Please scan your replacement QR code at this point.

Your concession will allow you to park for ${duration}, from ${validFrom} to ${validExpiry}.

Please note that concession payments are non-refundable.

If you continue to experience any issues or have any further queries, please contact: ${NHS_SUPPORT_EMAIL}

Kind regards,
Barts Health NHS Trust
Car Parking Services Team`;

  const trackingPixel = params.trackingPixelUrl
    ? `<img src="${params.trackingPixelUrl}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;" />`
    : "";

  const htmlText = `<div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #000000; line-height: 1.35;">
<br/>
Dear ${driverName},<br/><br/>
Please find attached your replacement concession QR code. We apologise for any inconvenience caused by the previous code.<br/><br/>
Please use this replacement QR code instead of your previous QR code.<br/><br/>
On your next visit, please take the replacement QR code to the pay machine, press Concession, and enter vehicle registration number <strong>${vrm}</strong>.<br/><br/>
The machine will then ask you to scan a blue badge or concession. Please scan your replacement QR code at this point.<br/><br/>
Your concession will allow you to park for ${duration}, from ${validFrom} to ${validExpiry}.<br/><br/>
Please note that concession payments are non-refundable.<br/><br/>
If you continue to experience any issues or have any further queries, please contact: <a href="mailto:${NHS_SUPPORT_EMAIL}" style="color: #005EB8; text-decoration: underline;">${NHS_SUPPORT_EMAIL}</a><br/><br/>
Kind regards,<br/>
Barts Health NHS Trust<br/>
Car Parking Services Team
${trackingPixel}
</div>`;

  return { subject, plainText, htmlText };
}

export const getResendConcessionEmailContent = getReplacementEmailContent;

/**
 * Template 3: Cancellation Notice
 * Generates specific cancellation messages for the 3 scenarios:
 * 1. Date Invalid (Future): 2+ days ahead
 * 2. Expired (Too Old): 7+ days ago
 * 3. Duplicate (Same VRM): active permit exists
 */
export function getCancellationEmailContent(
  params: EmailTemplateParams,
  reasonOverride?: CancellationReason
): EmailContentResult {
  const vrm = formatVrmForEmail(params.vrm);
  const driverName = formatDriverNameForEmail(params.driverName);
  const { validFrom } = deriveDateRangeForEmail(params);

  // Determine effective cancellation reason
  let reason: CancellationReason = reasonOverride || params.reason || 'future';
  if (!reasonOverride && !params.reason) {
    const rawReason = String(params.cancellationReason || "").trim().toUpperCase();
    if (rawReason === "DUPLICATE_VRM" || rawReason === "DUPLICATE") {
      reason = "duplicate";
    } else if (rawReason === "EXPIRED") {
      reason = "expired";
    } else if (rawReason === "FUTURE") {
      reason = "future";
    } else if (params.currentExpiryDate || params.activePermitExpiry) {
      reason = "duplicate";
    } else {
      const validFromIso = parseDateToISO(params.validFrom || params.dateRequired || "");
      const refIso = parseDateToISO(params.todayDate) || getTodayISO();
      if (validFromIso && refIso) {
        const [vy, vm, vd] = validFromIso.split("-").map(Number);
        const [ry, rm, rd] = refIso.split("-").map(Number);
        const daysDiff = Math.floor((new Date(vy, vm - 1, vd).getTime() - new Date(ry, rm - 1, rd).getTime()) / (1000 * 60 * 60 * 24));
        if (daysDiff > 1) {
          reason = 'future';
        } else if (daysDiff <= -7) {
          reason = 'expired';
        } else {
          reason = 'duplicate';
        }
      } else {
        reason = 'expired';
      }
    }
  }

  // Guard: If active permit dates exist and reason is not explicitly provided, it is a duplicate
  if (!reasonOverride && !params.reason && (params.currentExpiryDate || params.activePermitExpiry)) {
    const rawReason = String(params.cancellationReason || "").trim().toUpperCase();
    if (rawReason === "DUPLICATE_VRM" || rawReason === "DUPLICATE" || rawReason === "" || rawReason === "MANUAL" || reason === 'future' || reason === 'expired') {
      const validFromIso = parseDateToISO(params.validFrom || params.dateRequired || "");
      const refIso = parseDateToISO(params.todayDate) || getTodayISO();
      if (validFromIso && refIso) {
        const [vy, vm, vd] = validFromIso.split("-").map(Number);
        const [ry, rm, rd] = refIso.split("-").map(Number);
        const daysDiff = Math.floor((new Date(vy, vm - 1, vd).getTime() - new Date(ry, rm - 1, rd).getTime()) / (1000 * 60 * 60 * 24));
        if (daysDiff <= 1 && daysDiff > -7) {
          reason = 'duplicate';
        }
      } else {
        reason = 'duplicate';
      }
    }
  }

  // Guard: a past date or date within normal window can NEVER be "in the future" (Category 1: 2+ days ahead)
  if (reason === 'future') {
    const validFromIso = parseDateToISO(params.validFrom || params.dateRequired || "");
    const refIso = parseDateToISO(params.todayDate) || getTodayISO();
    if (validFromIso && refIso) {
      const [vy, vm, vd] = validFromIso.split("-").map(Number);
      const [ry, rm, rd] = refIso.split("-").map(Number);
      const daysDiff = Math.floor((new Date(vy, vm - 1, vd).getTime() - new Date(ry, rm - 1, rd).getTime()) / (1000 * 60 * 60 * 24));
      if (daysDiff <= 1) {
        if (daysDiff <= -7) {
          reason = 'expired';
        } else {
          reason = (params.currentExpiryDate || params.activePermitExpiry) ? 'duplicate' : 'expired';
        }
      }
    }
  }

  // Guard: a date that is NOT 7+ days old can NEVER be "expired" if an active permit for this VRM exists (Category 2: 7+ days ago)
  if (reason === 'expired') {
    const validFromIso = parseDateToISO(params.validFrom || params.dateRequired || "");
    const refIso = parseDateToISO(params.todayDate) || getTodayISO();
    if (validFromIso && refIso) {
      const [vy, vm, vd] = validFromIso.split("-").map(Number);
      const [ry, rm, rd] = refIso.split("-").map(Number);
      const daysDiff = Math.floor((new Date(vy, vm - 1, vd).getTime() - new Date(ry, rm - 1, rd).getTime()) / (1000 * 60 * 60 * 24));
      if (daysDiff > -7 && (params.currentExpiryDate || params.activePermitExpiry || String(params.cancellationReason || "").trim().toUpperCase().includes("DUPLICATE"))) {
        reason = 'duplicate';
      }
    }
  }

  const subject = `Cancelled: Concession Permit – ${vrm}`;

  let plainText = "";
  let htmlText = "";

  if (reason === 'duplicate') {
    // Format Current Expiry Date
    let currentExpiry = "[Current Expiry Date]";
    const rawExpiry = params.currentExpiryDate || params.activePermitExpiry || "";
    if (rawExpiry) {
      const f = formatDate(rawExpiry);
      if (f && f !== "-") {
        currentExpiry = f;
      }
    }

    // Format Earliest Renewal Date
    let earliestRenewal = "[Earliest Renewal Date]";
    const rawRenewal = params.earliestRenewalDate || params.reapplyDate || "";
    if (rawRenewal) {
      const f = formatDate(rawRenewal);
      if (f && f !== "-") {
        earliestRenewal = f;
      }
    } else if (rawExpiry) {
      const expiryIso = parseDateToISO(rawExpiry);
      if (expiryIso) {
        const nextDayIso = addDays(expiryIso, 1);
        if (nextDayIso) {
          const f = formatDate(nextDayIso);
          if (f && f !== "-") {
            earliestRenewal = f;
          }
        }
      }
    }

    plainText = `Dear ${driverName},

We have received your parking concession request for vehicle ${vrm}.

Our records show that this vehicle already has an active permit valid through ${currentExpiry}. Your new concession request has been cancelled because your current permit is still active.

You can submit a new concession request from ${earliestRenewal}, after your current permit expires.

If you continue to experience any issues or have any further queries, please contact: ${NHS_SUPPORT_EMAIL}

Kind regards,
Barts Health NHS Trust
Car Parking Services Team`;

    htmlText = `<div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #000000; line-height: 1.35;">
Dear ${driverName},<br/><br/>
We have received your parking concession request for vehicle <strong>${vrm}</strong>.<br/><br/>
Our records show that this vehicle already has an active permit valid through ${currentExpiry}. Your new concession request has been cancelled because your current permit is still active.<br/><br/>
You can submit a new concession request from ${earliestRenewal}, after your current permit expires.<br/><br/>
If you continue to experience any issues or have any further queries, please contact: <a href="mailto:${NHS_SUPPORT_EMAIL}" style="color: #005EB8; text-decoration: underline;">${NHS_SUPPORT_EMAIL}</a><br/><br/>
Kind regards,<br/>
Barts Health NHS Trust<br/>
Car Parking Services Team
</div>`;
  } else if (reason === 'expired') {
    plainText = `Dear ${driverName},

We have received your parking concession request for vehicle ${vrm}.

The 7-day validity period for this concession has ended, so your request has been cancelled.

If you require a new concession, please contact your ward or department to submit a new concession request.

If you continue to experience any issues or have any further queries, please contact: ${NHS_SUPPORT_EMAIL}

Kind regards,
Barts Health NHS Trust
Car Parking Services Team`;

    htmlText = `<div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #000000; line-height: 1.35;">
Dear ${driverName},<br/><br/>
We have received your parking concession request for vehicle <strong>${vrm}</strong>.<br/><br/>
The 7-day validity period for this concession has ended, so your request has been cancelled.<br/><br/>
If you require a new concession, please contact your ward or department to submit a new concession request.<br/><br/>
If you continue to experience any issues or have any further queries, please contact: <a href="mailto:${NHS_SUPPORT_EMAIL}" style="color: #005EB8; text-decoration: underline;">${NHS_SUPPORT_EMAIL}</a><br/><br/>
Kind regards,<br/>
Barts Health NHS Trust<br/>
Car Parking Services Team
</div>`;
  } else {
    // Default / 'future': Date Invalid (Future)
    plainText = `Dear ${driverName},

We have received your parking concession request for vehicle ${vrm}.

The start date on your application was set to ${validFrom}, which is in the future. To prevent issuing an invalid concession, this request has been cancelled.

If you still require parking, please contact your ward or department to submit a new concession request.

If you continue to experience any issues or have any further queries, please contact: ${NHS_SUPPORT_EMAIL}

Kind regards,
Barts Health NHS Trust
Car Parking Services Team`;

    htmlText = `<div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #000000; line-height: 1.35;">
Dear ${driverName},<br/><br/>
We have received your parking concession request for vehicle <strong>${vrm}</strong>.<br/><br/>
The start date on your application was set to ${validFrom}, which is in the future. To prevent issuing an invalid concession, this request has been cancelled.<br/><br/>
If you still require parking, please contact your ward or department to submit a new concession request.<br/><br/>
If you continue to experience any issues or have any further queries, please contact: <a href="mailto:${NHS_SUPPORT_EMAIL}" style="color: #005EB8; text-decoration: underline;">${NHS_SUPPORT_EMAIL}</a><br/><br/>
Kind regards,<br/>
Barts Health NHS Trust<br/>
Car Parking Services Team
</div>`;
  }

  return { subject, plainText, htmlText };
}