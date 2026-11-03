import { ParsedVoucherData, CsvPermitRecord, cleanVoucherCodeValue, parseDateToISO, addDaysSafe } from './csvParser';
import { getVoucherValidFromISO } from './voucherValidation';

export function reconcileVoucherUpload(
  existing: ParsedVoucherData[],
  incoming: ParsedVoucherData[],
  permits: CsvPermitRecord[]
): {
  merged: ParsedVoucherData[];
  withdrawnCount: number;
  stalePermits: { id: string; vrm: string; code: string; date: string }[];
} {
  const incomingValidFroms = new Set<string>();
  const incomingCodes = new Set<string>();

  (incoming || []).forEach(v => {
    if (!v || !v.code) return;
    const clean = cleanVoucherCodeValue(v.code).toUpperCase();
    if (clean && clean !== "-") {
      incomingCodes.add(clean);
    }
    const vf = getVoucherValidFromISO(v) || parseDateToISO(v.validFrom || v.valid_from || "");
    if (vf) incomingValidFroms.add(vf);
  });

  const mergedMap = new Map<string, ParsedVoucherData>();

  // Populate mergedMap from existing database
  (existing || []).forEach(v => {
    if (!v.code) return;
    const cleanKey = cleanVoucherCodeValue(v.code).toUpperCase();
    if (cleanKey && cleanKey !== "-") {
      mergedMap.set(cleanKey, { ...v });
    }
  });

  // Helper to check if a voucher code is assigned to any active/sent permit
  const isCodeAssignedToPermit = (codeUpper: string): boolean => {
    return (permits || []).some(r => {
      const isCancelledRec = r.isCancelled === true ||
        String(r.status || "").trim().toUpperCase() === "CANCELLED" ||
        r.voucherCode === "CANCELLED" ||
        r.prePaidCode === "CANCELLED" ||
        r.voucherCodesText === "CANCELLED";
      const wasSent = r.status === 'SENT' || r.status === 'sent' || r.isDispatched === true || r.emailSent === true;
      const shouldReserve = !isCancelledRec || wasSent;
      if (!shouldReserve) return false;

      const codes = [r.voucherCode, r.replacementCode, r.originalVoucherCode, r.preCancelVoucherCode, r.prePaidCode];
      return codes.some(c => c && cleanVoucherCodeValue(c).toUpperCase() === codeUpper);
    });
  };

  let withdrawnCount = 0;
  const stalePermitsList: { id: string; vrm: string; code: string; date: string }[] = [];
  const seenStalePermitKeys = new Set<string>();

  // Reconcile existing vouchers whose validFrom is in incomingValidFroms but code is NOT in incomingCodes
  for (const [cleanKey, existingV] of mergedMap.entries()) {
    const existingVf = getVoucherValidFromISO(existingV) || parseDateToISO(existingV.validFrom || existingV.valid_from || "");
    if (existingVf && incomingValidFroms.has(existingVf)) {
      if (!incomingCodes.has(cleanKey)) {
        const assigned = isCodeAssignedToPermit(cleanKey);
        if (!assigned) {
          // Withdraw
          mergedMap.set(cleanKey, {
            ...existingV,
            status: "withdrawn",
            isUsed: true,
            notInLatestExport: false
          });
          withdrawnCount++;
        } else {
          // Stale assigned: keep status active, set notInLatestExport true
          mergedMap.set(cleanKey, {
            ...existingV,
            status: "active",
            notInLatestExport: true
          });
          const matchingRecords = (permits || []).filter(r => {
            const isCancelledRec = r.isCancelled === true ||
              String(r.status || "").trim().toUpperCase() === "CANCELLED" ||
              r.voucherCode === "CANCELLED" ||
              r.prePaidCode === "CANCELLED" ||
              r.voucherCodesText === "CANCELLED";
            const wasSent = r.status === 'SENT' || r.status === 'sent' || r.isDispatched === true || r.emailSent === true;
            const shouldReserve = !isCancelledRec || wasSent;
            if (!shouldReserve) return false;

            const codes = [r.voucherCode, r.replacementCode, r.originalVoucherCode, r.preCancelVoucherCode, r.prePaidCode];
            return codes.some(c => c && cleanVoucherCodeValue(c).toUpperCase() === cleanKey);
          });
          matchingRecords.forEach(r => {
            const pKey = String(r.formId || r.id || r.vrm);
            if (!seenStalePermitKeys.has(pKey)) {
              seenStalePermitKeys.add(pKey);
              stalePermitsList.push({
                id: String(r.formId || r.id || "-"),
                vrm: r.vrm || "-",
                code: cleanKey,
                date: r.dateRequired || r.validFrom || "-"
              });
            }
          });
        }
      }
    }
  }

  // Process incoming vouchers (merging, un-withdrawing, clearing notInLatestExport if present)
  (incoming || []).forEach(v => {
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
          status: v.status || "active",
          isUsed: v.isUsed !== undefined ? v.isUsed : false,
          notInLatestExport: false,
          vrm: v.vrm || existing.vrm,
          validFrom: effectiveValidFrom,
          validTo: effectiveValidTo,
          valid_from: effectiveValidFrom,
          valid_to: effectiveValidTo
        });
      } else {
        mergedMap.set(cleanKey, {
          ...v,
          status: v.status || "active",
          isUsed: v.isUsed !== undefined ? v.isUsed : false,
          notInLatestExport: false,
          validFrom: effectiveValidFrom,
          validTo: effectiveValidTo,
          valid_from: effectiveValidFrom,
          valid_to: effectiveValidTo
        });
      }
    }
  });

  return {
    merged: Array.from(mergedMap.values()),
    withdrawnCount,
    stalePermits: stalePermitsList
  };
}
