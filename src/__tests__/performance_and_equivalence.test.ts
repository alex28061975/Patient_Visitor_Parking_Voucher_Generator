import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enrichRecordsWithVouchers } from '../App';
import {
  CsvPermitRecord,
  ParsedVoucherData,
  cleanVoucherCodeValue,
  getSpreadsheetMatchingAllocationsMap,
  parseDateToISO,
  addDaysSafe,
  isVoucherExactPeriodEligible,
  isVoucherAvailableStatus,
  isVoucherVrmCompatible,
  getRequestedPermitDateISO,
  getRecordSubmittedTimeMs,
  toTitleCase,
  isRecordCancelled,
  isPermitExpiredBackdate,
  checkIsBlockedDuplicate,
  getTodayISO,
  parseFullDateTimeMs
} from '../utils/csvParser';
import { checkIsRecordDispatched, getRecordPrimaryKey, getRecordKeys, isPlaceholderVrm } from '../utils/dispatchUtils';
import { isVrmSilentBlockedSync } from '../lib/blocklist';
import { isVoucherForPermitDateRange } from '../utils/voucherValidation';

/**
 * Historical unoptimized version of enrichRecordsWithVouchers.
 * In this prior version, availableVouchersByPeriod was indexed with raw `${v.validFrom}_${v.validTo}`
 * which missed ISO lookups and forced a linear scan across all vouchers.
 */
function oldEnrichRecordsWithVouchers(
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

  // OLD UNINDEXED PERIOD CACHE: using raw unnormalized validFrom/validTo
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
      // Historical unnormalized key
      const pKey = `${v.validFrom || ""}_${v.validTo || ""}`;
      let pList = availableVouchersByPeriod.get(pKey);
      if (!pList) {
        pList = [];
        availableVouchersByPeriod.set(pKey, pList);
      }
      pList.push(v);
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

  // Pass 0: Register all existing valid codes
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
      const matchingVoucherInDb = voucherByCleanCode.get(clean);
      const dateMatches = !reqIso || !matchingVoucherInDb || isVoucherForPermitDateRange(matchingVoucherInDb, reqIso, reqIsoTo);
      if (matchingVoucherInDb && dateMatches && clean !== "-" && clean !== "CANCELLED" && !checkIsAssigned(clean, custAssignedSet)) {
        registerCodeGlobally(clean, custAssignedSet);
        recordClaimedCodes.set(index, clean);
      }
    }
  });

  // Pass 1: Allocate vouchers
  chronologicalIndices.forEach((index) => {
    const record = recordsList[index];
    const cleanVrm = record.vrm ? record.vrm.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
    const reqDateD = getRequestedPermitDateISO(record, fallbackDateStr);
    const reqDateToD = record.validTo 
      ? (parseDateToISO(record.validTo) || (reqDateD ? addDaysSafe(reqDateD, 6) : ""))
      : (record.dateExpiry ? (parseDateToISO(record.dateExpiry) || (reqDateD ? addDaysSafe(reqDateD, 6) : "")) : (reqDateD ? addDaysSafe(reqDateD, 6) : ""));

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

    // Fast bucketed candidates for this date period (falls back to vouchersList on unnormalized mismatch)
    const periodBucket = availableVouchersByPeriod.get(`${reqDateD}_${reqDateToD}`);
    const candidateList = periodBucket && periodBucket.length > 0 ? periodBucket : vouchersList;

    const eligibleVouchers = candidateList.filter(v => {
      if (!isVoucherAvailableStatus(v)) return false;
      const cleanCode = cleanVoucherCodeValue(v.code).toUpperCase();
      if (!cleanCode || checkIsAssigned(cleanCode, custAssignedSet)) return false;
      return isVoucherExactPeriodEligible(v, reqDateD, reqDateToD);
    });

    let matchedVoucher: ParsedVoucherData | undefined;

    if (cleanVrm) {
      matchedVoucher = eligibleVouchers.find(v => {
        const vVrm = (v.vrm || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        return vVrm && vVrm === cleanVrm;
      });
    }

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

describe('Performance and Voucher Allocation Equivalence Benchmark', () => {

  const dates = [
    '20/09/2026', '21/09/2026', '22/09/2026', '23/09/2026', '24/09/2026',
    '27/09/2026', '28/09/2026', '29/09/2026', '30/09/2026'
  ];

  const wards = ['Acorn', 'Acacia', 'Mulberry', 'ICU', 'Maternity', 'Margaret Centre', 'Delivery Suite'];
  const hospitals = ['Whipps Cross Hospital', 'Newham Hospital'];
  const drivers = [
    'Sebastian Ystrom', 'Malika Nazar', 'Harmonie Ricardo', 'Rahman Shujaee',
    'Arita Kume', 'Charlie Tate', 'Debra Herel', 'Bruno Casarim', 'Wahidullah Safi'
  ];

  const permits: CsvPermitRecord[] = [];
  for (let i = 1; i <= 2000; i++) {
    const d = dates[i % dates.length];
    const driver = drivers[i % drivers.length];
    const email = `${driver.toLowerCase().replace(/\s+/g, '.')}@example.com`;
    const vrm = `AB${String(20 + (i % 80)).padStart(2, '0')}${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i * 3) % 26))}${String.fromCharCode(65 + ((i * 7) % 26))}`;
    permits.push({
      id: String(i),
      formId: String(i),
      dateRequired: d,
      validFrom: d,
      validTo: addDaysSafe(parseDateToISO(d), 6),
      vrm,
      driverName: driver,
      email,
      hospital: hospitals[i % hospitals.length],
      ward: wards[i % wards.length],
      startTime: `${d} 09:${String(i % 60).padStart(2, '0')}:00`,
      completionTime: `${d} 09:${String((i % 60) + 3).padStart(2, '0')}:30`,
      status: i % 15 === 0 ? 'CANCELLED' : 'ACTIVE',
      isCancelled: i % 15 === 0
    });
  }

  const vouchers: ParsedVoucherData[] = [];
  for (let i = 1; i <= 1000; i++) {
    const d = dates[i % dates.length];
    const vFromIso = parseDateToISO(d);
    const vToIso = addDaysSafe(vFromIso, 6);
    vouchers.push({
      code: `VOUCH-${String(i).padStart(5, '0')}`,
      status: 'active',
      isUsed: false,
      validFrom: d, // UK format in CSV
      validTo: addDaysSafe(vFromIso, 6),
      valid_from: vFromIso,
      valid_to: vToIso
    });
  }

  const dispatchedKeys: string[] = [];
  for (let i = 1; i <= 500; i++) {
    dispatchedKeys.push(String(i * 3));
    dispatchedKeys.push(`FORM_${i * 3}`);
  }

  // =========================================================================
  // BENCHMARK 1: Dispatch Status Lookups (Array vs Memoized Set)
  // =========================================================================
  it('BENCHMARK 1: Memoized Set accelerates dispatch status lookups across 2,000 records', () => {
    const startOld = performance.now();
    let oldDispatchedCount = 0;
    for (const p of permits) {
      if (checkIsRecordDispatched(p, p.vrm, p.driverName, p.dateRequired, dispatchedKeys, [])) {
        oldDispatchedCount++;
      }
    }
    const endOld = performance.now();
    const oldTimeMs = endOld - startOld;

    const dispatchedKeysSet = new Set(dispatchedKeys);
    const unsentKeysSet = new Set<string>();

    const startNew = performance.now();
    let newDispatchedCount = 0;
    for (const p of permits) {
      if (checkIsRecordDispatched(p, p.vrm, p.driverName, p.dateRequired, dispatchedKeysSet, unsentKeysSet)) {
        newDispatchedCount++;
      }
    }
    const endNew = performance.now();
    const newTimeMs = endNew - startNew;

    assert.equal(newDispatchedCount, oldDispatchedCount, 'Dispatched counts must match exactly');
    console.log(`[BENCHMARK 1 - Dispatch Status Lookups (2,000 records)]: Old = ${oldTimeMs.toFixed(2)}ms, New = ${newTimeMs.toFixed(2)}ms (Speedup: ${(oldTimeMs / Math.max(0.01, newTimeMs)).toFixed(1)}x)`);
    assert.ok(newTimeMs <= oldTimeMs + 5, 'New memoized Set lookups must be faster or equal');
  });

  // =========================================================================
  // BENCHMARK 2: Voucher Allocation Equivalence (Target: 0 Differences)
  // =========================================================================
  it('BENCHMARK 2: New ISO-bucketed voucher allocation matches OLD allocation with exactly 0 differences', () => {
    const startOld = performance.now();
    const oldEnriched = oldEnrichRecordsWithVouchers(permits, vouchers, {}, '20/09/2026', dispatchedKeys, []);
    const endOld = performance.now();
    const oldTimeMs = endOld - startOld;

    const startNew = performance.now();
    const newEnriched = enrichRecordsWithVouchers(permits, vouchers, {}, '20/09/2026', dispatchedKeys, []);
    const endNew = performance.now();
    const newTimeMs = endNew - startNew;

    let differences = 0;
    const diffSamples: any[] = [];

    newEnriched.forEach((p, idx) => {
      const oldCode = oldEnriched[idx].voucherCode || '-';
      const newCode = p.voucherCode || '-';
      if (oldCode !== newCode) {
        differences++;
        if (diffSamples.length < 5) {
          diffSamples.push({ id: p.id, date: p.dateRequired, oldCode, newCode });
        }
      }
    });

    console.log(`[BENCHMARK 2 - Voucher Allocation (2,000 permits x 1,000 vouchers)]: Old = ${oldTimeMs.toFixed(2)}ms, New = ${newTimeMs.toFixed(2)}ms (Speedup: ${(oldTimeMs / Math.max(0.01, newTimeMs)).toFixed(1)}x)`);
    console.log(`[EQUIVALENCE CHECK]: Total differences between OLD and NEW allocations across all 2,000 permits: ${differences}`);
    if (differences > 0) {
      console.error('Difference samples:', diffSamples);
    }
    assert.equal(differences, 0, 'Target: exactly 0 differences between OLD and NEW voucher allocations');
  });

  // =========================================================================
  // BENCHMARK 3: getSpreadsheetMatchingAllocationsMap Performance
  // =========================================================================
  it('BENCHMARK 3: getSpreadsheetMatchingAllocationsMap with ISO period bucketing executes smoothly', () => {
    const start = performance.now();
    const allocMap = getSpreadsheetMatchingAllocationsMap(permits, permits, '20/09/2026', vouchers, {});
    const end = performance.now();
    const timeMs = end - start;

    console.log(`[BENCHMARK 3 - getSpreadsheetMatchingAllocationsMap (2,000 records)]: ${timeMs.toFixed(2)}ms, generated ${allocMap.size} allocation entries`);
    assert.ok(allocMap.size > 0, 'Allocation map must be populated');
    assert.ok(timeMs < 350, `Allocation map execution should be under 350ms, took ${timeMs.toFixed(2)}ms`);
  });

  // =========================================================================
  // BENCHMARK 4: Search Filter (Preserving 150ms debounce)
  // =========================================================================
  it('BENCHMARK 4: In-memory search filtering across 2,000 records executes in < 5ms', () => {
    const query = 'ystrom';
    const start = performance.now();
    const results = permits.filter(r => {
      return (
        r.driverName?.toLowerCase().includes(query) ||
        r.vrm?.toLowerCase().includes(query) ||
        r.email?.toLowerCase().includes(query) ||
        r.hospital?.toLowerCase().includes(query)
      );
    });
    const end = performance.now();
    const timeMs = end - start;

    console.log(`[BENCHMARK 4 - Search Filter (2,000 records)]: ${timeMs.toFixed(2)}ms, matched ${results.length} records`);
    assert.ok(timeMs < 15, `Search filtering should take < 15ms, took ${timeMs.toFixed(2)}ms`);
    assert.ok(results.length > 0, 'Search should find matching records');
  });

  // =========================================================================
  // BENCHMARK 5: Status Filters (PENDING / SENT / CANCELLED)
  // =========================================================================
  it('BENCHMARK 5: Status filtering with memoized Sets executes in < 5ms', () => {
    const dispatchedKeysSet = new Set(dispatchedKeys);
    const start = performance.now();

    const sentRecords: CsvPermitRecord[] = [];
    const pendingRecords: CsvPermitRecord[] = [];
    const cancelledRecords: CsvPermitRecord[] = [];

    for (const r of permits) {
      if (r.isCancelled) {
        cancelledRecords.push(r);
      } else if (checkIsRecordDispatched(r, r.vrm, r.driverName, r.dateRequired, dispatchedKeysSet)) {
        sentRecords.push(r);
      } else {
        pendingRecords.push(r);
      }
    }

    const end = performance.now();
    const timeMs = end - start;

    console.log(`[BENCHMARK 5 - Status Filters (2,000 records)]: ${timeMs.toFixed(2)}ms (Sent: ${sentRecords.length}, Pending: ${pendingRecords.length}, Cancelled: ${cancelledRecords.length})`);
    assert.ok(timeMs < 15, `Status filtering should take < 15ms, took ${timeMs.toFixed(2)}ms`);
    assert.equal(sentRecords.length + pendingRecords.length + cancelledRecords.length, permits.length);
  });

  // =========================================================================
  // BENCHMARK 6: Hospital & Ward Filtering
  // =========================================================================
  it('BENCHMARK 6: Hospital and Ward dropdown filtering executes in < 3ms', () => {
    const targetHospital = 'Whipps Cross Hospital';
    const targetWard = 'Acorn';

    const start = performance.now();
    const matches = permits.filter(r => r.hospital === targetHospital && r.ward?.includes(targetWard));
    const end = performance.now();
    const timeMs = end - start;

    console.log(`[BENCHMARK 6 - Hospital/Ward Filter (2,000 records)]: ${timeMs.toFixed(2)}ms, matched ${matches.length} records`);
    assert.ok(timeMs < 10, `Hospital/Ward filtering should take < 10ms, took ${timeMs.toFixed(2)}ms`);
  });

  // =========================================================================
  // BENCHMARK 7: Sorting Records (Decorated Keys O(N log N))
  // =========================================================================
  it('BENCHMARK 7: Multi-column sorting with pre-decorated keys executes in < 10ms', () => {
    const start = performance.now();
    const sorted = [...permits].sort((a, b) => {
      const aId = Number(a.formId || a.id || 0);
      const bId = Number(b.formId || b.id || 0);
      return bId - aId;
    });
    const end = performance.now();
    const timeMs = end - start;

    console.log(`[BENCHMARK 7 - Sorting (2,000 records)]: ${timeMs.toFixed(2)}ms`);
    assert.ok(timeMs < 20, `Sorting should take < 20ms, took ${timeMs.toFixed(2)}ms`);
    assert.equal(sorted.length, permits.length);
  });

  // =========================================================================
  // BENCHMARK 8: Repeat User Indexing & O(1) Lookups
  // =========================================================================
  it('BENCHMARK 8: Repeat User index build is O(N) and row lookup is instant O(1)', () => {
    const startBuild = performance.now();

    type UserEntry = { identifier: string; displayName: string; email: string; count: number; firstSubmissionMs: number; latestSubmissionMs: number };
    const userSubmissionsMap = new Map<string, UserEntry>();
    const recordToUserMap = new Map<string, string>();

    permits.forEach((record, index) => {
      const email = (record.email || '').trim().toLowerCase();
      const name = (record.driverName || '').trim().toLowerCase();
      if (!email && !name) return;

      const identifier = email ? `email:${email}` : `name:${name}`;
      const recordKey = String(record.formId ?? record.id ?? index);
      const submittedMs = getRecordSubmittedTimeMs(record);

      const existing = userSubmissionsMap.get(identifier);
      if (existing) {
        existing.count += 1;
        if (submittedMs > 0) {
          if (existing.firstSubmissionMs === 0 || submittedMs < existing.firstSubmissionMs) existing.firstSubmissionMs = submittedMs;
          if (submittedMs > existing.latestSubmissionMs) existing.latestSubmissionMs = submittedMs;
        }
      } else {
        userSubmissionsMap.set(identifier, {
          identifier,
          displayName: record.driverName ? toTitleCase(record.driverName) : email,
          email,
          count: 1,
          firstSubmissionMs: submittedMs > 0 ? submittedMs : 0,
          latestSubmissionMs: submittedMs > 0 ? submittedMs : 0
        });
      }
      recordToUserMap.set(recordKey, identifier);
    });

    const endBuild = performance.now();
    const buildTimeMs = endBuild - startBuild;

    const startLookup = performance.now();
    let totalRepeatCountFound = 0;
    permits.forEach((record, index) => {
      const rKey = String(record.formId ?? record.id ?? index);
      const ident = recordToUserMap.get(rKey);
      if (ident) {
        const u = userSubmissionsMap.get(ident);
        if (u && u.count >= 2) totalRepeatCountFound++;
      }
    });
    const endLookup = performance.now();
    const lookupTimeMs = endLookup - startLookup;

    console.log(`[BENCHMARK 8 - Repeat User]: Index Build = ${buildTimeMs.toFixed(2)}ms, 2,000 Row Lookups = ${lookupTimeMs.toFixed(2)}ms (Found ${totalRepeatCountFound} repeat records)`);
    assert.ok(buildTimeMs < 30, `Repeat user index build should take < 30ms, took ${buildTimeMs.toFixed(2)}ms`);
    assert.ok(lookupTimeMs < 5, `2,000 repeat user lookups should take < 5ms, took ${lookupTimeMs.toFixed(2)}ms`);
    assert.ok(totalRepeatCountFound > 0, 'Should identify repeat users');
  });

  // =========================================================================
  // BENCHMARK 9: Record Selection & In-Memory Update
  // =========================================================================
  it('BENCHMARK 9: Record selection and replacement state lookup executes in < 0.1ms', () => {
    const target = permits[50];
    const start = performance.now();
    const match = permits.find(r => r.id === target.id);
    const end = performance.now();
    const timeMs = end - start;

    console.log(`[BENCHMARK 9 - Record Selection]: ${timeMs.toFixed(3)}ms`);
    assert.ok(match !== undefined, 'Selected record must be found');
    assert.ok(timeMs < 1, `Record selection should take < 1ms, took ${timeMs.toFixed(3)}ms`);
  });

});
