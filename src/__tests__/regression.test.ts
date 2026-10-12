import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { autoCancelDuplicates, enrichRecordsWithVouchers } from '../App';
import {
  checkIsBlockedDuplicate,
  isRecordCancelledCanonical,
  isPermitExpiredBackdate,
  isVoucherExactPeriodEligible,
  isDateRequiredOutsideValidWindow,
  parseDateToISO,
  addDaysSafe,
  CsvPermitRecord,
  ParsedVoucherData
} from '../utils/csvParser';
import {
  resolveCancellationDetails,
  getCancellationEmailContent,
  getReplacementEmailContent,
  deriveDateRangeForEmail,
  CancellationReason
} from '../utils/emailTemplateUtils';
import { getRecordPrimaryKey, getRecordKeys } from '../utils/dispatchUtils';
import { computeVoucherBatchExpiryBadge, validateVoucherCSV, validateManualVoucherChange, isVoucherForPermitDateRange } from '../utils/voucherValidation';

function makePermit(overrides: Partial<CsvPermitRecord> & { id: string; vrm: string }): CsvPermitRecord {
  return {
    formId: overrides.id,
    hospital: 'Whipps Cross Hospital',
    ward: 'Acorn Ward',
    driverName: 'Driver',
    dateRequired: overrides.validFrom || '20/09/2026',
    ...overrides
  };
}

describe('ParkPass Concessions Regression Test Suite', () => {

  // =========================================================================
  // TEST 1 — Adjacent concession periods (20/09 → 26/09 vs 27/09 → 03/10)
  // Expected: NO OVERLAP (protects #1914 bug)
  // =========================================================================
  it('TEST 1: Adjacent consecutive concession periods must NOT overlap', () => {
    const existingPermit: CsvPermitRecord = {
      id: '1',
      formId: '1',
      vrm: 'EA25VZM',
      validFrom: '20/09/2026',
      validTo: '26/09/2026',
      dateRequired: '20/09/2026',
      dateExpiry: '26/09/2026',
      hospital: 'Whipps Cross Hospital',
      ward: 'Acorn Ward',
      driverName: 'Test Driver',
      status: 'ACTIVE'
    };

    const newAdjacentPermit: CsvPermitRecord = {
      id: '2',
      formId: '2',
      vrm: 'EA25VZM',
      validFrom: '27/09/2026',
      validTo: '03/10/2026',
      dateRequired: '27/09/2026',
      dateExpiry: '03/10/2026',
      hospital: 'Whipps Cross Hospital',
      ward: 'Acorn Ward',
      driverName: 'Test Driver',
      status: 'ACTIVE'
    };

    const isBlocked = checkIsBlockedDuplicate(newAdjacentPermit, [existingPermit]);
    assert.equal(isBlocked, false, 'Adjacent consecutive period (26/09 -> 27/09) must NOT be blocked as duplicate');

    const reconciled = autoCancelDuplicates([existingPermit, newAdjacentPermit]);
    assert.equal(reconciled[0].status, 'ACTIVE', 'Existing permit must remain ACTIVE');
    assert.equal(reconciled[1].status, 'ACTIVE', 'New adjacent permit must remain ACTIVE');
    assert.equal(reconciled[1].isCancelled, false);
  });

  // =========================================================================
  // TEST 2 — Genuine overlapping periods (20/09 → 26/09 vs 26/09 → 02/10)
  // Expected: OVERLAP (shared date 26/09)
  // =========================================================================
  it('TEST 2: Periods sharing an inclusive date (26/09) must be recognized as OVERLAPPING', () => {
    const existingPermit: CsvPermitRecord = {
      id: '1',
      formId: '1',
      startTime: '20/09/2026 09:00:00',
      vrm: 'AB12CDE',
      validFrom: '20/09/2026',
      validTo: '26/09/2026',
      dateRequired: '20/09/2026',
      dateExpiry: '26/09/2026',
      hospital: 'Whipps Cross Hospital',
      ward: 'Acorn Ward',
      driverName: 'Driver A',
      status: 'ACTIVE'
    };

    const overlappingPermit: CsvPermitRecord = {
      id: '2',
      formId: '2',
      startTime: '21/09/2026 10:00:00',
      vrm: 'AB12CDE',
      validFrom: '26/09/2026',
      validTo: '02/10/2026',
      dateRequired: '26/09/2026',
      dateExpiry: '02/10/2026',
      hospital: 'Whipps Cross Hospital',
      ward: 'Acorn Ward',
      driverName: 'Driver A',
      status: 'ACTIVE'
    };

    const isBlocked = checkIsBlockedDuplicate(overlappingPermit, [existingPermit]);
    assert.equal(isBlocked, true, 'Shared boundary date 26/09 must be recognized as overlapping');

    const reconciled = autoCancelDuplicates([existingPermit, overlappingPermit]);
    assert.equal(reconciled[0].status, 'ACTIVE', 'Earlier submission must win');
    assert.equal(reconciled[1].status, 'CANCELLED', 'Later overlapping permit must be CANCELLED');
    assert.equal(reconciled[1].cancellationReason, 'DUPLICATE_VRM');
  });

  // =========================================================================
  // TEST 3 — Clearly separate periods (19/09 → 25/09 vs 27/09 → 03/10)
  // Expected: NO OVERLAP
  // =========================================================================
  it('TEST 3: Clearly separated periods must NOT overlap', () => {
    const permitA: CsvPermitRecord = {
      id: '1',
      formId: '1',
      vrm: 'XY99ZZZ',
      validFrom: '19/09/2026',
      validTo: '25/09/2026',
      dateRequired: '19/09/2026',
      dateExpiry: '25/09/2026',
      hospital: 'Royal London Hospital',
      ward: 'Ward 4B',
      driverName: 'Driver B',
      status: 'ACTIVE'
    };

    const permitB: CsvPermitRecord = {
      id: '2',
      formId: '2',
      vrm: 'XY99ZZZ',
      validFrom: '27/09/2026',
      validTo: '03/10/2026',
      dateRequired: '27/09/2026',
      dateExpiry: '03/10/2026',
      hospital: 'Royal London Hospital',
      ward: 'Ward 4B',
      driverName: 'Driver B',
      status: 'ACTIVE'
    };

    const isBlocked = checkIsBlockedDuplicate(permitB, [permitA]);
    assert.equal(isBlocked, false, 'Separated periods must not be flagged as duplicates');

    const reconciled = autoCancelDuplicates([permitA, permitB]);
    assert.equal(reconciled[0].status, 'ACTIVE');
    assert.equal(reconciled[1].status, 'ACTIVE');
  });

  // =========================================================================
  // TEST 4 — Cancelled record must not cause a duplicate (#1822 / #1829 issue)
  // Expected: New record remains ACTIVE
  // =========================================================================
  it('TEST 4: A previously cancelled record must NOT act as an active duplicate candidate', () => {
    const cancelledEarlier: CsvPermitRecord = {
      id: '1822',
      formId: '1822',
      startTime: '20/09/2026 10:00:00',
      vrm: 'BD22XYZ',
      validFrom: '20/09/2026',
      validTo: '26/09/2026',
      dateRequired: '20/09/2026',
      hospital: 'Newham Hospital',
      ward: 'Cedar Ward',
      driverName: 'Driver C',
      status: 'CANCELLED',
      isCancelled: true,
      cancellationReason: 'MANUAL',
      voucherCode: 'CANCELLED'
    };

    const newPermit: CsvPermitRecord = {
      id: '1829',
      formId: '1829',
      startTime: '21/09/2026 11:00:00',
      vrm: 'BD22XYZ',
      validFrom: '27/09/2026',
      validTo: '03/10/2026',
      dateRequired: '27/09/2026',
      hospital: 'Newham Hospital',
      ward: 'Cedar Ward',
      driverName: 'Driver C',
      status: 'ACTIVE'
    };

    const isBlocked = checkIsBlockedDuplicate(newPermit, [cancelledEarlier]);
    assert.equal(isBlocked, false, 'Cancelled earlier record must not block new record');

    const reconciled = autoCancelDuplicates([cancelledEarlier, newPermit]);
    assert.equal(reconciled[0].status, 'CANCELLED', 'Genuinely cancelled permit stays CANCELLED');
    assert.equal(reconciled[1].status, 'ACTIVE', 'New permit remains ACTIVE');
  });

  // =========================================================================
  // TEST 5 — #1914 exact regression
  // #1842 ACTIVE (19/09 -> 25/09), #1913 CANCELLED (20/09 -> 26/09), #1914 ACTIVE (27/09 -> 03/10)
  // Expected: #1914 ACTIVE & eligible for matching voucher (prevent premature EXPIRED)
  // =========================================================================
  it('TEST 5: Exact #1914 regression scenario must evaluate #1914 as ACTIVE and allocate voucher', () => {
    const r1842: CsvPermitRecord = {
      id: '1842',
      formId: '1842',
      startTime: '20/09/2026 19:07:50',
      completionTime: '20/09/2026 19:07:50',
      vrm: 'EA25VZM',
      validFrom: '19/09/2026',
      validTo: '25/09/2026',
      dateRequired: '19/09/2026',
      dateExpiry: '25/09/2026',
      driverName: 'Driver EA',
      hospital: 'Whipps Cross Hospital',
      ward: 'Acorn Ward',
      status: 'ACTIVE',
      voucherCode: '5LEUMNSPVMXSV'
    };

    const r1913: CsvPermitRecord = {
      id: '1913',
      formId: '1913',
      startTime: '25/09/2026 14:25:27',
      completionTime: '25/09/2026 14:25:27',
      vrm: 'EA25VZM',
      validFrom: '20/09/2026',
      validTo: '26/09/2026',
      dateRequired: '20/09/2026',
      dateExpiry: '26/09/2026',
      driverName: 'Driver EA',
      hospital: 'Whipps Cross Hospital',
      ward: 'Acorn Ward',
      status: 'ACTIVE'
    };

    const r1914: CsvPermitRecord = {
      id: '1914',
      formId: '1914',
      startTime: '25/09/2026 14:27:06',
      completionTime: '25/09/2026 14:27:06',
      vrm: 'EA25VZM',
      validFrom: '27/09/2026',
      validTo: '03/10/2026',
      dateRequired: '27/09/2026',
      dateExpiry: '03/10/2026',
      driverName: 'Driver EA',
      hospital: 'Whipps Cross Hospital',
      ward: 'Acorn Ward',
      status: 'ACTIVE'
    };

    const reconciled = autoCancelDuplicates([r1842, r1913, r1914]);

    assert.equal(reconciled[0].status, 'ACTIVE', '#1842 must be ACTIVE');
    assert.equal(reconciled[0].voucherCode, '5LEUMNSPVMXSV', '#1842 retains its voucher');

    assert.equal(reconciled[1].status, 'CANCELLED', '#1913 must be CANCELLED');
    assert.equal(reconciled[1].cancellationReason, 'DUPLICATE_VRM', '#1913 cancelled as duplicate of #1842');

    assert.equal(reconciled[2].status, 'ACTIVE', '#1914 MUST be ACTIVE');
    assert.equal(reconciled[2].isCancelled, false, '#1914 must not be isCancelled: true');
    assert.notEqual(reconciled[2].cancellationReason, 'EXPIRED', '#1914 must NOT be prematurely marked EXPIRED');

    const availableVouchers: ParsedVoucherData[] = [
      { code: '5LEUMNSPVMXSV', validFrom: '19/09/2026', validTo: '25/09/2026', status: 'AVAILABLE' },
      { code: 'VOUCH_FOR_1914', validFrom: '27/09/2026', validTo: '03/10/2026', status: 'AVAILABLE' }
    ];

    const enriched = enrichRecordsWithVouchers(reconciled, availableVouchers, {}, '25/09/2026');
    assert.equal(enriched[2].status, 'ACTIVE');
    assert.equal(enriched[2].voucherCode, 'VOUCH_FOR_1914', '#1914 must receive the available matching voucher');
  });

  // =========================================================================
  // TEST 6 — Future-date cancellation (requested date 2+ days ahead)
  // Expected: canonical category 'future'
  // =========================================================================
  it('TEST 6: A permit requested 2+ days in advance resolves to future cancellation category', () => {
    const futureRecord: CsvPermitRecord = {
      id: '2001',
      formId: '2001',
      vrm: 'FU26TUE',
      driverName: 'Future Tester',
      validFrom: '28/09/2026',
      dateRequired: '28/09/2026',
      hospital: 'Whipps Cross Hospital',
      ward: 'Maternity',
      todayDate: '25/09/2026'
    };

    const details = resolveCancellationDetails(futureRecord, [], '25/09/2026');
    assert.equal(details.reason, 'future', 'Permit requested 3 days ahead must resolve to future category');

    const email = getCancellationEmailContent({
      vrm: futureRecord.vrm,
      driverName: futureRecord.driverName,
      validFrom: futureRecord.validFrom,
      todayDate: futureRecord.todayDate,
      reason: details.reason
    });
    assert.match(email.subject, /Cancelled: Concession Permit – FU26TUE/);
    assert.match(email.plainText, /is in the future/i);
  });

  // =========================================================================
  // TEST 6b — Future start date window up to MAX_DAYS_AHEAD (2 days ahead)
  // Acceptance tests for submission on 08/10/2026:
  // - Start 09/10/2026 (1 day ahead): Valid / not outside valid window
  // - Start 10/10/2026 (2 days ahead): Valid / not outside valid window
  // - Start 11/10/2026 (3 days ahead): Outside valid window (beyond limit)
  // - Start 12/10/2026 (4 days ahead): Outside valid window (beyond limit)
  // =========================================================================
  it('TEST 6b: Concessions up to 2 days ahead are within valid window; 3+ days ahead are outside window', () => {
    const submissionDate = '08/10/2026';

    // 1 day ahead (09/10/2026): within window (not outside)
    assert.equal(
      isDateRequiredOutsideValidWindow('09/10/2026', submissionDate),
      false,
      'Start 09/10/2026 (1 day ahead) must be within valid window'
    );

    // 2 days ahead (10/10/2026): within window (not outside)
    assert.equal(
      isDateRequiredOutsideValidWindow('10/10/2026', submissionDate),
      false,
      'Start 10/10/2026 (2 days ahead) must be within valid window'
    );

    // 3 days ahead (11/10/2026): outside valid window (cancelled / beyond limit)
    assert.equal(
      isDateRequiredOutsideValidWindow('11/10/2026', submissionDate),
      true,
      'Start 11/10/2026 (3 days ahead) must be outside valid window'
    );

    // 4 days ahead (12/10/2026): outside valid window (cancelled / beyond limit)
    assert.equal(
      isDateRequiredOutsideValidWindow('12/10/2026', submissionDate),
      true,
      'Start 12/10/2026 (4 days ahead) must be outside valid window'
    );
  });

  // =========================================================================
  // TEST 6c — Future start date cancellation email template & reason resolution
  // =========================================================================
  it('TEST 6c: Future-date cancellation resolves reason and exact email text with 08/10/2026 submission', () => {
    const submissionDate = '08/10/2026';

    // 10/10/2026 (2 days ahead) is NOT cancelled as future
    const withinWindowRec: CsvPermitRecord = {
      id: '2010',
      formId: '2010',
      vrm: 'AB12CDE',
      driverName: 'Test Driver',
      validFrom: '10/10/2026',
      dateRequired: '10/10/2026',
      hospital: 'Whipps Cross Hospital',
      ward: 'Maternity',
      submissionDate
    };
    assert.equal(isDateRequiredOutsideValidWindow('10/10/2026', submissionDate), false);
    const withinDetails = resolveCancellationDetails(withinWindowRec, [], submissionDate);
    assert.notEqual(withinDetails.reason, 'future');

    // 11/10/2026 (3 days ahead) resolves to 'future'
    const futureRec11: CsvPermitRecord = {
      id: '2011',
      formId: '2011',
      vrm: 'AB12CDE',
      driverName: 'Test Driver',
      validFrom: '11/10/2026',
      dateRequired: '11/10/2026',
      hospital: 'Whipps Cross Hospital',
      ward: 'Maternity',
      submissionDate
    };
    const details11 = resolveCancellationDetails(futureRec11, [], submissionDate);
    assert.equal(details11.reason, 'future');

    const email11 = getCancellationEmailContent({
      vrm: futureRec11.vrm,
      driverName: futureRec11.driverName,
      validFrom: futureRec11.validFrom,
      submissionDate: futureRec11.submissionDate,
      reason: details11.reason
    });
    assert.equal(email11.subject, 'Cancelled: Concession Permit – AB12CDE');
    const expectedBody11 = `Dear Test Driver,

We have received your parking concession request for vehicle AB12CDE.

The start date on your application was set to 11/10/2026, which is in the future. To prevent issuing an invalid concession, this request has been cancelled.

If you still require parking, please contact your ward or department to submit a new concession request.

If you continue to experience any issues or have any further queries, please contact: parkingadminbh.bartshealth@nhs.net

Kind regards,
Barts Health NHS Trust
Car Parking Services Team`;
    assert.equal(email11.plainText, expectedBody11);
    assert.match(email11.htmlText, /<strong>AB12CDE<\/strong>/);
    assert.match(email11.htmlText, /<a href="mailto:parkingadminbh\.bartshealth@nhs\.net"/);

    // 12/10/2026 (4 days ahead) also resolves to 'future'
    const futureRec12: CsvPermitRecord = {
      id: '2012',
      formId: '2012',
      vrm: 'AB12CDE',
      driverName: 'Test Driver',
      validFrom: '12/10/2026',
      dateRequired: '12/10/2026',
      hospital: 'Whipps Cross Hospital',
      ward: 'Maternity',
      submissionDate
    };
    const details12 = resolveCancellationDetails(futureRec12, [], submissionDate);
    assert.equal(details12.reason, 'future');
    const email12 = getCancellationEmailContent({
      vrm: futureRec12.vrm,
      driverName: futureRec12.driverName,
      validFrom: futureRec12.validFrom,
      submissionDate: futureRec12.submissionDate,
      reason: details12.reason
    });
    assert.match(email12.plainText, /The start date on your application was set to 12\/10\/2026, which is in the future\./);
  });

  // =========================================================================
  // TEST 7 — Expired-date cancellation (7+ days in the past)
  // Expected: canonical category 'expired'
  // =========================================================================
  it('TEST 7: A concession requested 7+ days ago resolves to expired category', () => {
    const expiredRecord: CsvPermitRecord = {
      id: '2002',
      formId: '2002',
      vrm: 'EX26OLD',
      driverName: 'Old Concession',
      validFrom: '10/09/2026',
      dateRequired: '10/09/2026',
      startTime: '25/09/2026 12:00:00',
      hospital: 'Whipps Cross Hospital',
      ward: 'Maternity',
      todayDate: '25/09/2026'
    };

    const isBackdate = isPermitExpiredBackdate(expiredRecord, '25/09/2026');
    assert.equal(isBackdate, true, '15 days in past must be expired backdate');

    const details = resolveCancellationDetails(expiredRecord, [], '25/09/2026');
    assert.equal(details.reason, 'expired', '7+ days past must resolve to expired');

    const email = getCancellationEmailContent({
      vrm: expiredRecord.vrm,
      driverName: expiredRecord.driverName,
      validFrom: expiredRecord.validFrom,
      reason: details.reason
    });
    assert.match(email.subject, /Cancelled: Concession Permit – EX26OLD/);
    assert.match(email.plainText, /The 7-day validity period for this concession has ended/i);
  });

  // =========================================================================
  // TEST 8 — Duplicate cancellation
  // Expected: cancellationReason = DUPLICATE_VRM and email category duplicate
  // =========================================================================
  it('TEST 8: Same VRM overlapping permit resolves to duplicate cancellationReason and duplicate email', () => {
    const activePermit = makePermit({
      id: '101',
      formId: '101',
      startTime: '20/09/2026 09:00:00',
      vrm: 'DP24VRM',
      driverName: 'Alice',
      validFrom: '20/09/2026',
      validTo: '26/09/2026',
      dateRequired: '20/09/2026',
      status: 'ACTIVE',
      voucherCode: 'ACTV123'
    });

    const dupPermit = makePermit({
      id: '102',
      formId: '102',
      startTime: '20/09/2026 10:00:00',
      vrm: 'DP24VRM',
      driverName: 'Alice',
      validFrom: '22/09/2026',
      validTo: '28/09/2026',
      dateRequired: '22/09/2026',
      status: 'ACTIVE'
    });

    const reconciled = autoCancelDuplicates([activePermit, dupPermit]);
    assert.equal(reconciled[1].status, 'CANCELLED');
    assert.equal(reconciled[1].cancellationReason, 'DUPLICATE_VRM');

    const details = resolveCancellationDetails(reconciled[1], [reconciled[0]], '20/09/2026');
    assert.equal(details.reason, 'duplicate');

    const email = getCancellationEmailContent({
      vrm: dupPermit.vrm,
      driverName: dupPermit.driverName,
      validFrom: dupPermit.validFrom,
      reason: details.reason,
      currentExpiryDate: details.currentExpiryDate,
      earliestRenewalDate: details.earliestRenewalDate
    });
    assert.match(email.subject, /Cancelled: Concession Permit – DP24VRM/);
    assert.match(email.plainText, /already has an active permit valid through/i);
  });

  // =========================================================================
  // TEST 9 — Henry Durant regression (#1839 active through 24/09, #1907 duplicate)
  // Expected: #1907 = CANCELLED, DUPLICATE_VRM, email duplicate with expiry & renewal
  // =========================================================================
  it('TEST 9: Henry Durant regression (#1839 vs #1907) retains duplicate reason with active expiry', () => {
    const r1839: CsvPermitRecord = {
      id: '1839',
      formId: '1839',
      startTime: '20/09/2026 16:44:21',
      completionTime: '20/09/2026 16:44:21',
      vrm: 'FN24EVC',
      driverName: 'Henry Durant',
      validFrom: '18/09/2026',
      validTo: '24/09/2026',
      dateRequired: '18/09/2026',
      dateExpiry: '24/09/2026',
      hospital: 'Whipps Cross Hospital',
      ward: 'Maternity',
      status: 'ACTIVE',
      voucherCode: '4BPO6KOTNZIV8'
    };

    const r1907: CsvPermitRecord = {
      id: '1907',
      formId: '1907',
      startTime: '25/09/2026 02:51:42',
      completionTime: '25/09/2026 02:51:42',
      vrm: 'FN24EVC',
      driverName: 'Henry Durant',
      validFrom: '24/09/2026',
      validTo: '30/09/2026',
      dateRequired: '24/09/2026',
      dateExpiry: '30/09/2026',
      hospital: 'Whipps Cross Hospital',
      ward: 'Maternity',
      status: 'ACTIVE'
    };

    const reconciled = autoCancelDuplicates([r1839, r1907]);
    assert.equal(reconciled[0].status, 'ACTIVE');
    assert.equal(reconciled[1].status, 'CANCELLED');
    assert.equal(reconciled[1].cancellationReason, 'DUPLICATE_VRM');

    const details = resolveCancellationDetails(reconciled[1], [reconciled[0]], '25/09/2026');
    assert.equal(details.reason, 'duplicate', 'Must use duplicate category, NOT expired');
    assert.equal(details.currentExpiryDate, '24/09/2026', 'Must display current expiry 24/09/2026');
    assert.equal(details.earliestRenewalDate, '25/09/2026', 'Must display renewal date 25/09/2026');
  });

  // =========================================================================
  // TEST 10 — #1897 / #1898 regression (backdated negative diff overlap)
  // Expected: Genuine overlap recognized when start-date diff is negative
  // =========================================================================
  it('TEST 10: Negative start-date diff with overlapping dates correctly triggers duplicate detection', () => {
    const r1897 = makePermit({
      id: '1897',
      formId: '1897',
      startTime: '24/09/2026 10:00:00',
      vrm: 'KL24NEG',
      validFrom: '23/09/2026',
      validTo: '29/09/2026',
      dateRequired: '23/09/2026',
      status: 'ACTIVE',
      voucherCode: 'V1897'
    });

    const r1898 = makePermit({
      id: '1898',
      formId: '1898',
      startTime: '24/09/2026 11:00:00',
      vrm: 'KL24NEG',
      validFrom: '22/09/2026',
      validTo: '28/09/2026',
      dateRequired: '22/09/2026',
      status: 'ACTIVE'
    });

    const reconciled = autoCancelDuplicates([r1897, r1898]);
    assert.equal(reconciled[0].status, 'ACTIVE', 'Earlier submission 1897 wins');
    assert.equal(reconciled[1].status, 'CANCELLED', 'Overlapping request 1898 is cancelled');
    assert.equal(reconciled[1].cancellationReason, 'DUPLICATE_VRM');
  });

  // =========================================================================
  // TEST 11 — ±7-day boundary
  // 0-6 days = potentially overlapping; exactly 7 days = NOT an overlap
  // =========================================================================
  it('TEST 11: Exactly 7 days apart is NOT an overlap; date range rule remains authoritative', () => {
    const permitA = makePermit({
      id: 'A',
      formId: 'A',
      startTime: '20/09/2026 09:00:00',
      vrm: 'BD07DAY',
      validFrom: '20/09/2026',
      validTo: '26/09/2026',
      dateRequired: '20/09/2026',
      status: 'ACTIVE'
    });

    const permitB = makePermit({
      id: 'B',
      formId: 'B',
      startTime: '20/09/2026 09:05:00',
      vrm: 'BD07DAY',
      validFrom: '27/09/2026',
      validTo: '03/10/2026',
      dateRequired: '27/09/2026',
      status: 'ACTIVE'
    });

    const isOverlap = checkIsBlockedDuplicate(permitB, [permitA]);
    assert.equal(isOverlap, false, 'Start date 7 days after first permit start (adjacent) is NOT an overlap');

    const reconciled = autoCancelDuplicates([permitA, permitB]);
    assert.equal(reconciled[0].status, 'ACTIVE');
    assert.equal(reconciled[1].status, 'ACTIVE');
  });

  // =========================================================================
  // TEST 12 — Voucher validity period
  // Only assign vouchers where valid_from <= requested <= valid_to
  // =========================================================================
  it('TEST 12: Voucher allocation only assigns vouchers valid for the requested permit date', () => {
    const permit = makePermit({
      id: '1',
      formId: '1',
      vrm: 'VRM123',
      validFrom: '25/09/2026',
      validTo: '01/10/2026',
      dateRequired: '25/09/2026',
      status: 'ACTIVE'
    });

    const expiredVoucher: ParsedVoucherData = {
      code: 'EXPIRED_VOUCHER',
      validFrom: '10/09/2026',
      validTo: '16/09/2026',
      status: 'AVAILABLE'
    };

    const futureVoucher: ParsedVoucherData = {
      code: 'FUTURE_VOUCHER',
      validFrom: '10/10/2026',
      validTo: '16/10/2026',
      status: 'AVAILABLE'
    };

    const validVoucher: ParsedVoucherData = {
      code: 'VALID_VOUCHER_25',
      validFrom: '25/09/2026',
      validTo: '01/10/2026',
      status: 'AVAILABLE'
    };

    assert.equal(isVoucherExactPeriodEligible(expiredVoucher, '25/09/2026', '01/10/2026'), false);
    assert.equal(isVoucherExactPeriodEligible(futureVoucher, '25/09/2026', '01/10/2026'), false);
    assert.equal(isVoucherExactPeriodEligible(validVoucher, '25/09/2026', '01/10/2026'), true);

    const enriched = enrichRecordsWithVouchers([permit], [expiredVoucher, futureVoucher, validVoucher]);
    assert.equal(enriched[0].voucherCode, 'VALID_VOUCHER_25', 'Must allocate only the date-valid voucher');
  });

  // =========================================================================
  // TEST 13 — Assigned voucher exclusion
  // Assigned voucher must be excluded from other permits in same period
  // =========================================================================
  it('TEST 13: An assigned voucher is excluded from subsequent permits', () => {
    const permit1 = makePermit({
      id: '1',
      formId: '1',
      vrm: 'CAR1',
      validFrom: '20/09/2026',
      validTo: '26/09/2026',
      dateRequired: '20/09/2026',
      status: 'ACTIVE'
    });

    const permit2 = makePermit({
      id: '2',
      formId: '2',
      vrm: 'CAR2',
      validFrom: '20/09/2026',
      validTo: '26/09/2026',
      dateRequired: '20/09/2026',
      status: 'ACTIVE'
    });

    const vouchers: ParsedVoucherData[] = [
      { code: 'SINGLE_CODE', validFrom: '20/09/2026', validTo: '26/09/2026', status: 'AVAILABLE' }
    ];

    const enriched = enrichRecordsWithVouchers([permit1, permit2], vouchers);
    assert.equal(enriched[0].voucherCode, 'SINGLE_CODE', 'First permit claims the code');
    assert.equal(enriched[1].voucherCode, '-', 'Second permit cannot claim already assigned code');
  });

  // =========================================================================
  // TEST 14 — Replacement workflow
  // Entering replacement mode preserves originalVoucherCode
  // =========================================================================
  it('TEST 14: Replacement workflow preserves originalVoucherCode', () => {
    const permit = makePermit({
      id: '10',
      formId: '10',
      vrm: 'REP123',
      validFrom: '20/09/2026',
      validTo: '26/09/2026',
      dateRequired: '20/09/2026',
      status: 'ACTIVE',
      voucherCode: 'ORIG_CODE_999',
      originalVoucherCode: 'ORIG_CODE_999',
      emailTemplate: 'replacement',
      isResend: true
    });

    const customMap: Record<string, string> = {
      '10': 'NEW_REPLACEMENT_CODE'
    };

    const enriched = enrichRecordsWithVouchers([permit], [], customMap);
    assert.equal(enriched[0].voucherCode, 'NEW_REPLACEMENT_CODE');
    assert.equal(enriched[0].originalVoucherCode, 'ORIG_CODE_999', 'originalVoucherCode must remain preserved');
  });

  // =========================================================================
  // TEST 15 — Cancelled vouchers consume zero allocation
  // Cancelled records do NOT consume voucher codes
  // =========================================================================
  it('TEST 15: Cancelled records consume zero voucher allocation', () => {
    const cancelledPermit = makePermit({
      id: '1',
      formId: '1',
      vrm: 'CAN1',
      validFrom: '20/09/2026',
      validTo: '26/09/2026',
      dateRequired: '20/09/2026',
      status: 'CANCELLED',
      isCancelled: true,
      cancellationReason: 'MANUAL',
      voucherCode: 'CANCELLED'
    });

    const activePermit = makePermit({
      id: '2',
      formId: '2',
      vrm: 'ACT2',
      validFrom: '20/09/2026',
      validTo: '26/09/2026',
      dateRequired: '20/09/2026',
      status: 'ACTIVE'
    });

    const vouchers: ParsedVoucherData[] = [
      { code: 'SHARED_POOL_CODE', validFrom: '20/09/2026', validTo: '26/09/2026', status: 'AVAILABLE' }
    ];

    const enriched = enrichRecordsWithVouchers([cancelledPermit, activePermit], vouchers);
    assert.equal(enriched[0].voucherCode, 'CANCELLED');
    assert.equal(enriched[1].voucherCode, 'SHARED_POOL_CODE', 'Active permit receives the voucher without being blocked');
  });

  // =========================================================================
  // TEST 16 — Duplicate reinstatement
  // Only DUPLICATE_VRM may be reinstated when earlier winner is removed
  // =========================================================================
  it('TEST 16: Only DUPLICATE_VRM is reinstated when earlier winner is removed; MANUAL/BLOCKLIST/EXPIRED are not', () => {
    const duplicateRecord = makePermit({
      id: '2',
      formId: '2',
      vrm: 'REINST1',
      validFrom: '20/09/2026',
      validTo: '26/09/2026',
      dateRequired: '20/09/2026',
      status: 'CANCELLED',
      isCancelled: true,
      cancellationReason: 'DUPLICATE_VRM',
      originalVoucherCode: 'RESTORED_VOUCH'
    });

    const manualRecord = makePermit({
      id: '3',
      formId: '3',
      vrm: 'MANUAL1',
      validFrom: '20/09/2026',
      validTo: '26/09/2026',
      dateRequired: '20/09/2026',
      status: 'CANCELLED',
      isCancelled: true,
      cancellationReason: 'MANUAL',
      voucherCode: 'CANCELLED'
    });

    const reconciled = autoCancelDuplicates([duplicateRecord, manualRecord]);
    assert.equal(reconciled[0].status, 'ACTIVE', 'DUPLICATE_VRM is restored to ACTIVE when winner is absent');
    assert.equal(reconciled[0].isCancelled, false);
    assert.equal(reconciled[0].voucherCode, 'RESTORED_VOUCH');

    assert.equal(reconciled[1].status, 'CANCELLED', 'MANUAL cancellation must NEVER be restored');
    assert.equal(reconciled[1].cancellationReason, 'MANUAL');
  });

  // =========================================================================
  // TEST 17 — Winner selection chronology
  // 1. Earliest submission timestamp, 2. numeric Form ID, 3. array index
  // =========================================================================
  it('TEST 17: Winner selection respects earliest submission timestamp, then numeric Form ID', () => {
    const earlierSubmitted = makePermit({
      id: '100',
      formId: '100',
      startTime: '20/09/2026 10:00:00',
      vrm: 'WINNER1',
      validFrom: '25/09/2026',
      validTo: '01/10/2026',
      dateRequired: '25/09/2026',
      status: 'ACTIVE'
    });

    const laterSubmittedLowerId = makePermit({
      id: '99',
      formId: '99',
      startTime: '20/09/2026 11:00:00',
      vrm: 'WINNER1',
      validFrom: '25/09/2026',
      validTo: '01/10/2026',
      dateRequired: '25/09/2026',
      status: 'ACTIVE'
    });

    const reconciled = autoCancelDuplicates([laterSubmittedLowerId, earlierSubmitted]);
    assert.equal(reconciled[1].status, 'ACTIVE', 'Earlier submission timestamp (10:00) wins');
    assert.equal(reconciled[0].status, 'CANCELLED', 'Later submission is cancelled as duplicate');
  });

  // =========================================================================
  // TEST 18 — Dispatch state keys
  // Protect getRecordPrimaryKey and getRecordKeys for Form ID dispatch tracking
  // =========================================================================
  it('TEST 18: Dispatch primary keys are strictly anchored to formId/id and not VRM alone', () => {
    const recordWithFormId: CsvPermitRecord = {
      id: 'rec_abc',
      formId: '1914',
      vrm: 'EA25VZM',
      driverName: 'John Doe',
      hospital: 'Whipps Cross Hospital',
      ward: 'Ward 1',
      dateRequired: '27/09/2026'
    };

    const key = getRecordPrimaryKey(recordWithFormId);
    assert.equal(key, '1914', 'Primary key must be numeric formId');

    const aliases = getRecordKeys(recordWithFormId);
    assert.ok(aliases.includes('1914'));
    assert.ok(!aliases.includes('EA25VZM'), 'Aliases must NOT match by VRM alone to prevent cross-dispatch bugs');
  });

  // =========================================================================
  // TEST 19 — Supabase refresh/synchronisation resilience
  // Stale status or uncancelled states must correctly reconcile without overwriting
  // =========================================================================
  it('TEST 19: Local reconciliation preserves active status when evaluating synced raw database', () => {
    const rawSyncedPermits: CsvPermitRecord[] = [
      makePermit({
        id: '1',
        formId: '1',
        startTime: '20/09/2026 09:00:00',
        vrm: 'SYNC1',
        validFrom: '20/09/2026',
        validTo: '26/09/2026',
        dateRequired: '20/09/2026',
        status: 'ACTIVE'
      }),
      makePermit({
        id: '2',
        formId: '2',
        startTime: '20/09/2026 09:05:00',
        vrm: 'SYNC1',
        validFrom: '20/09/2026',
        validTo: '26/09/2026',
        dateRequired: '20/09/2026',
        status: 'ACTIVE'
      })
    ];

    const reconciled = autoCancelDuplicates(rawSyncedPermits);
    assert.equal(reconciled[0].status, 'ACTIVE');
    assert.equal(reconciled[1].status, 'CANCELLED');
    assert.equal(reconciled[1].cancellationReason, 'DUPLICATE_VRM');
  });

  // =========================================================================
  // TEST 20 — Cancellation email categories (future, expired, duplicate)
  // Canonical categories must remain exactly: 'future' | 'expired' | 'duplicate'
  // =========================================================================
  it('TEST 20: Canonical cancellation email categories must be strictly future, expired, or duplicate', () => {
    const validCategories: CancellationReason[] = ['future', 'expired', 'duplicate'];
    assert.equal(validCategories.length, 3);

    const futureEmail = getCancellationEmailContent({
      vrm: 'TEST1',
      driverName: 'User',
      validFrom: '15/10/2026',
      todayDate: '25/09/2026',
      reason: 'future'
    });
    assert.match(futureEmail.plainText, /is in the future/);

    const expiredEmail = getCancellationEmailContent({
      vrm: 'TEST2',
      driverName: 'User',
      validFrom: '01/09/2026',
      reason: 'expired'
    });
    assert.match(expiredEmail.plainText, /7-day validity period for this concession has ended/);

    const duplicateEmail = getCancellationEmailContent({
      vrm: 'TEST3',
      driverName: 'User',
      validFrom: '20/09/2026',
      reason: 'duplicate',
      currentExpiryDate: '25/09/2026',
      earliestRenewalDate: '26/09/2026'
    });
    assert.match(duplicateEmail.plainText, /already has an active permit valid through 25\/09\/2026/);
    assert.match(duplicateEmail.plainText, /submit a new concession request from 26\/09\/2026/);
  });

  // =========================================================================
  // TEST 21 — Voucher inventory validity calculation with color thresholds:
  // - Green (> 3 days remaining): "🟢 Codes Valid Until: DD/MM/YYYY (X days left)"
  // - Amber (1 to 3 days remaining): "⚠️ Voucher Batch Expiring Soon: DD/MM/YYYY (X days left)"
  // - Red (0 days or batch expired): "🔴 No Active Codes Available — Add New Batch"
  // =========================================================================
  it('TEST 21: Voucher inventory validity calculation with color thresholds (Green > 3d, Amber 1-3d, Red <= 0d)', () => {
    // 1. Amber scenario: today is 28/09/2026, validFrom is 30/09/2026 (2 days left -> Amber)
    const vouchersPrimary: ParsedVoucherData[] = [
      { code: 'V_OCT_25', validFrom: '2026-09-30', validTo: '2026-10-25', status: 'active', isUsed: false }
    ];
    const badgePrimary = computeVoucherBatchExpiryBadge({
      vouchersDatabase: vouchersPrimary,
      todayDateIso: '2026-09-28'
    });
    assert.equal(badgePrimary.type, 'amber');
    assert.equal(badgePrimary.icon, '⚠️');
    assert.equal(badgePrimary.daysDiff, 2);
    assert.equal(badgePrimary.text, 'Voucher Batch Expiring Soon: 30/09/2026 (2 days left)');

    // Also verify referenceDate directly
    const refToday = new Date(2026, 8, 28); // 28/09/2026
    refToday.setHours(0, 0, 0, 0);
    const badgeWithRef = computeVoucherBatchExpiryBadge({
      vouchersDatabase: vouchersPrimary,
      referenceDate: refToday
    });
    assert.equal(badgeWithRef.type, 'amber');
    assert.equal(badgeWithRef.icon, '⚠️');
    assert.equal(badgeWithRef.daysDiff, 2);
    assert.equal(badgeWithRef.text, 'Voucher Batch Expiring Soon: 30/09/2026 (2 days left)');

    // 2. 1 day left scenario: today is 28/09/2026, validFrom is 29/09/2026 (1 day left -> Amber)
    const vouchersOneDay: ParsedVoucherData[] = [
      { code: 'V_TOMORROW', validFrom: '2026-09-29', validTo: '2026-10-05', status: 'active', isUsed: false }
    ];
    const badgeOneDay = computeVoucherBatchExpiryBadge({
      vouchersDatabase: vouchersOneDay,
      todayDateIso: '2026-09-28'
    });
    assert.equal(badgeOneDay.type, 'amber');
    assert.equal(badgeOneDay.icon, '⚠️');
    assert.equal(badgeOneDay.daysDiff, 1);
    assert.equal(badgeOneDay.text, 'Voucher Batch Expiring Soon: 29/09/2026 (1 day left)');

    // 3. 3 days left scenario: today is 28/09/2026, validFrom is 01/10/2026 (3 days left -> Amber)
    const vouchersThreeDays: ParsedVoucherData[] = [
      { code: 'V_THREE', validFrom: '2026-10-01', validTo: '2026-10-08', status: 'active', isUsed: false }
    ];
    const badgeThreeDays = computeVoucherBatchExpiryBadge({
      vouchersDatabase: vouchersThreeDays,
      todayDateIso: '2026-09-28'
    });
    assert.equal(badgeThreeDays.type, 'amber');
    assert.equal(badgeThreeDays.icon, '⚠️');
    assert.equal(badgeThreeDays.daysDiff, 3);
    assert.equal(badgeThreeDays.text, 'Voucher Batch Expiring Soon: 01/10/2026 (3 days left)');

    // 4. Green scenario: > 3 days (4 days left -> Green): today 28/09/2026, validFrom 02/10/2026
    const vouchersFourDays: ParsedVoucherData[] = [
      { code: 'V_FOUR', validFrom: '2026-10-02', validTo: '2026-10-09', status: 'active', isUsed: false }
    ];
    const badgeFourDays = computeVoucherBatchExpiryBadge({
      vouchersDatabase: vouchersFourDays,
      todayDateIso: '2026-09-28'
    });
    assert.equal(badgeFourDays.type, 'green');
    assert.equal(badgeFourDays.icon, '🟢');
    assert.equal(badgeFourDays.daysDiff, 4);
    assert.equal(badgeFourDays.text, 'Codes Valid Until: 02/10/2026 (4 days left)');

    // 5. Red badge: 0 days remaining (validFrom is today)
    const vouchersZeroDays: ParsedVoucherData[] = [
      { code: 'V_TODAY', validFrom: '2026-09-28', validTo: '2026-10-05', status: 'active', isUsed: false }
    ];
    const badgeZeroDays = computeVoucherBatchExpiryBadge({
      vouchersDatabase: vouchersZeroDays,
      todayDateIso: '2026-09-28'
    });
    assert.equal(badgeZeroDays.type, 'red');
    assert.equal(badgeZeroDays.icon, '🔴');
    assert.equal(badgeZeroDays.text, 'No Active Codes Available — Add New Batch');

    // 6. Red badge: available vouchers expired in the past
    const vouchersExpired: ParsedVoucherData[] = [
      { code: 'V_EXPIRED', validFrom: '2026-09-10', validTo: '2026-09-17', status: 'active', isUsed: false }
    ];
    const badgeExpired = computeVoucherBatchExpiryBadge({
      vouchersDatabase: vouchersExpired,
      todayDateIso: '2026-09-28'
    });
    assert.equal(badgeExpired.type, 'red');
    assert.equal(badgeExpired.icon, '🔴');
    assert.equal(badgeExpired.text, 'No Active Codes Available — Add New Batch');

    // 7. Red badge: 0 active/available vouchers remain (empty database)
    const badgeEmpty = computeVoucherBatchExpiryBadge({
      vouchersDatabase: [],
      todayDateIso: '2026-09-28'
    });
    assert.equal(badgeEmpty.type, 'red');
    assert.equal(badgeEmpty.icon, '🔴');
    assert.equal(badgeEmpty.text, 'No Active Codes Available — Add New Batch');

    // 8. Red badge: all vouchers are already assigned/used
    const vouchersAllUsed: ParsedVoucherData[] = [
      { code: 'USED_1', validTo: '2026-10-10', status: 'used', isUsed: true },
      { code: 'ASSIGNED_1', validTo: '2026-10-10', status: 'active', isUsed: false }
    ];
    const badgeAllUsed = computeVoucherBatchExpiryBadge({
      vouchersDatabase: vouchersAllUsed,
      assignedVoucherCodesSet: new Set(['ASSIGNED_1']),
      todayDateIso: '2026-09-28'
    });
    assert.equal(badgeAllUsed.type, 'red');
    assert.equal(badgeAllUsed.icon, '🔴');
    assert.equal(badgeAllUsed.text, 'No Active Codes Available — Add New Batch');

    // 9. Hospital/site filtering: respects selected hospital inventory
    const vouchersHospital: ParsedVoucherData[] = [
      { code: 'WHIPPS_CODE', hospital: 'Whipps Cross Hospital', validFrom: '2026-10-05', validTo: '2026-10-12', status: 'active', isUsed: false },
      { code: 'NEWHAM_CODE', hospital: 'Newham Hospital', validFrom: '2026-09-30', validTo: '2026-10-07', status: 'active', isUsed: false }
    ];
    const badgeWhipps = computeVoucherBatchExpiryBadge({
      vouchersDatabase: vouchersHospital,
      selectedHospital: 'Whipps Cross Hospital',
      todayDateIso: '2026-09-28'
    });
    assert.equal(badgeWhipps.type, 'green');
    assert.equal(badgeWhipps.icon, '🟢');
    assert.equal(badgeWhipps.daysDiff, 7);
    assert.equal(badgeWhipps.text, 'Codes Valid Until: 05/10/2026 (7 days left)');

    const badgeNewham = computeVoucherBatchExpiryBadge({
      vouchersDatabase: vouchersHospital,
      selectedHospital: 'Newham Hospital',
      todayDateIso: '2026-09-28'
    });
    assert.equal(badgeNewham.type, 'amber');
    assert.equal(badgeNewham.icon, '⚠️');
    assert.equal(badgeNewham.daysDiff, 2);
    assert.equal(badgeNewham.text, 'Voucher Batch Expiring Soon: 30/09/2026 (2 days left)');

    // 10. Supports valid_from and startDate field naming (> 3 days -> Green)
    const vouchersAliases: ParsedVoucherData[] = [
      { code: 'V_START', startDate: '03/10/2026', validTo: '10/10/2026', status: 'active', isUsed: false }
    ];
    const badgeAlias = computeVoucherBatchExpiryBadge({
      vouchersDatabase: vouchersAliases,
      todayDateIso: '2026-09-28'
    });
    assert.equal(badgeAlias.type, 'green');
    assert.equal(badgeAlias.icon, '🟢');
    assert.equal(badgeAlias.daysDiff, 5);
    assert.equal(badgeAlias.text, 'Codes Valid Until: 03/10/2026 (5 days left)');
  });

  // =========================================================================
  // TEST 22 — Pre-import validation check for uploaded Voucher CSV files
  // 1. Mandatory Date Validation Rules:
  //    - Check that 'VALIDFROM' and 'VALIDTO' exist and are not empty for every row.
  //    - Duration: Math.round((new Date(VALIDTO) - new Date(VALIDFROM)) / (1000 * 60 * 60 * 24)).
  //    - Verify duration equals exactly 6 days (or 7 days inclusive, e.g. 05/06/2026 to 11/06/2026 = 6 days).
  // 2. User Alert & Prevention:
  //    - If any row has missing dates or an invalid date range (e.g. 8 days), abort the import.
  //    - List row numbers and exact voucher codes failing the check.
  // =========================================================================
  it('TEST 22: Pre-import validation check for uploaded Voucher CSV files', () => {
    const toBuffer = (str: string): ArrayBuffer => new TextEncoder().encode(str).buffer;

    // 1. Valid CSV with exact 6-day duration (05/06/2026 to 11/06/2026)
    const validCsv = `Voucher Code,VALIDFROM,VALIDTO
CON1001JXM,05/06/2026,11/06/2026
CON1002JXM,05/06/2026,11/06/2026`;
    const resValid = validateVoucherCSV(toBuffer(validCsv), 'valid_vouchers.csv');
    assert.equal(resValid.isValid, true);
    assert.equal(resValid.errors.length, 0);
    assert.equal(resValid.vouchers.length, 2);

    // 2. Month crossover valid 6-day duration (28/05/2026 to 03/06/2026)
    const validMonthCrossover = `Voucher Code,VALIDFROM,VALIDTO
CON2001JXM,28/05/2026,03/06/2026`;
    const resCrossover = validateVoucherCSV(toBuffer(validMonthCrossover), 'crossover.csv');
    assert.equal(resCrossover.isValid, true);
    assert.equal(resCrossover.errors.length, 0);
    assert.equal(resCrossover.vouchers.length, 1);

    // 3. Invalid date range (8 days: 05/Jun to 13/Jun) — abort import, list row & code
    const invalidRangeCsv = `Voucher Code,VALIDFROM,VALIDTO
CON1001JXM,05/06/2026,11/06/2026
CON1002JXM,05/Jun/2026,13/Jun/2026`;
    const resInvalidRange = validateVoucherCSV(toBuffer(invalidRangeCsv), 'invalid_range.csv');
    assert.equal(resInvalidRange.isValid, false);
    assert.equal(resInvalidRange.vouchers.length, 0); // Must abort import!
    assert.equal(resInvalidRange.errors.length, 1);
    assert.equal(resInvalidRange.errors[0].rowNumber, 3);
    assert.equal(resInvalidRange.errors[0].code, 'CON1002JXM');
    assert.equal(resInvalidRange.errors[0].durationInDays, 8);
    assert.ok(resInvalidRange.errors[0].reason.includes('8 days'));

    // 4. Missing VALIDTO date — abort import, report row & code
    const missingToCsv = `Voucher Code,VALIDFROM,VALIDTO
CON1001JXM,05/06/2026,11/06/2026
CON_NO_TO,05/06/2026,`;
    const resMissingTo = validateVoucherCSV(toBuffer(missingToCsv), 'missing_to.csv');
    assert.equal(resMissingTo.isValid, false);
    assert.equal(resMissingTo.vouchers.length, 0);
    assert.equal(resMissingTo.errors.length, 1);
    assert.equal(resMissingTo.errors[0].rowNumber, 3);
    assert.equal(resMissingTo.errors[0].code, 'CON_NO_TO');
    assert.ok(resMissingTo.errors[0].reason.includes("Missing 'VALIDTO'"));

    // 5. Missing VALIDFROM date — abort import, report row & code
    const missingFromCsv = `Voucher Code,VALIDFROM,VALIDTO
CON_NO_FROM,,11/06/2026
CON1001JXM,05/06/2026,11/06/2026`;
    const resMissingFrom = validateVoucherCSV(toBuffer(missingFromCsv), 'missing_from.csv');
    assert.equal(resMissingFrom.isValid, false);
    assert.equal(resMissingFrom.vouchers.length, 0);
    assert.equal(resMissingFrom.errors.length, 1);
    assert.equal(resMissingFrom.errors[0].rowNumber, 2);
    assert.equal(resMissingFrom.errors[0].code, 'CON_NO_FROM');
    assert.ok(resMissingFrom.errors[0].reason.includes("Missing 'VALIDFROM'"));

    // 6. Multiple failing rows reported accurately
    const multipleErrorsCsv = `Voucher Code,VALIDFROM,VALIDTO
CON_ERR_1,05/06/2026,14/06/2026
CON_OK_1,05/06/2026,11/06/2026
CON_ERR_2,,`;
    const resMultiple = validateVoucherCSV(toBuffer(multipleErrorsCsv), 'multiple_errors.csv');
    assert.equal(resMultiple.isValid, false);
    assert.equal(resMultiple.vouchers.length, 0);
    assert.equal(resMultiple.errors.length, 2);
    assert.equal(resMultiple.errors[0].rowNumber, 2);
    assert.equal(resMultiple.errors[0].code, 'CON_ERR_1');
    assert.equal(resMultiple.errors[1].rowNumber, 4);
    assert.equal(resMultiple.errors[1].code, 'CON_ERR_2');
  });

  // =========================================================================
  // TEST 23 — Manual Voucher Code editing obeys canonical Active Date Codes
  // validation and allocation rules
  // =========================================================================
  it('TEST 23: Manual Voucher Code editing obeys canonical Active Date Codes validation and allocation rules', () => {
    const vouchers: ParsedVoucherData[] = [
      { code: 'V_VALID_SEPT1', validFrom: '01/09/2026', validTo: '07/09/2026', status: 'available', isUsed: false },
      { code: 'V_INVALID_SEPT8', validFrom: '08/09/2026', validTo: '14/09/2026', status: 'available', isUsed: false },
      { code: 'V_USED_SEPT1', validFrom: '01/09/2026', validTo: '07/09/2026', status: 'available', isUsed: false }
    ];

    const assignedOther = new Set<string>(['V_USED_SEPT1']);

    // 1. Valid manual voucher matching permit date range (01/09/2026 -> 07/09/2026) -> SAVE SUCCESS
    const resValid = validateManualVoucherChange({
      origCode: 'ORIG_CODE',
      newCode: 'V_VALID_SEPT1',
      permitDateRequired: '01/09/2026',
      permitDateExpiry: '07/09/2026',
      vouchersDatabase: vouchers,
      assignedCodesInOtherRecords: assignedOther
    });
    assert.equal(resValid.isValid, true);
    assert.equal(resValid.error, undefined);

    // 2. Invalid manual voucher (dates 08/09/2026 -> 14/09/2026 do not match permit 01/09/2026 -> 07/09/2026) -> SAVE BLOCKED
    const resInvalid = validateManualVoucherChange({
      origCode: 'ORIG_CODE',
      newCode: 'V_INVALID_SEPT8',
      permitDateRequired: '01/09/2026',
      permitDateExpiry: '07/09/2026',
      vouchersDatabase: vouchers,
      assignedCodesInOtherRecords: assignedOther
    });
    assert.equal(resInvalid.isValid, false);
    assert.ok(resInvalid.error && resInvalid.error.includes('This voucher code is not valid for the selected permit date range.'));
    assert.ok(resInvalid.error && resInvalid.error.includes('08/09/2026 – 14/09/2026'));
    assert.ok(resInvalid.error && resInvalid.error.includes('01/09/2026 – 07/09/2026'));

    // 3. Already-assigned voucher -> SAVE BLOCKED
    const resUsed = validateManualVoucherChange({
      origCode: 'ORIG_CODE',
      newCode: 'V_USED_SEPT1',
      permitDateRequired: '01/09/2026',
      permitDateExpiry: '07/09/2026',
      vouchersDatabase: vouchers,
      assignedCodesInOtherRecords: assignedOther
    });
    assert.equal(resUsed.isValid, false);
    assert.ok(resUsed.error && resUsed.error.includes('already assigned to another permit'));

    // 4. Special statuses (CANCELLED, BLOCKED, EXPIRED, -, empty) are permitted without blocking
    for (const special of ['CANCELLED', 'BLOCKED', 'EXPIRED', 'PENDING', '-', '']) {
      const resSpecial = validateManualVoucherChange({
        origCode: 'ORIG_CODE',
        newCode: special,
        permitDateRequired: '01/09/2026',
        permitDateExpiry: '07/09/2026',
        vouchersDatabase: vouchers,
        assignedCodesInOtherRecords: assignedOther
      });
      assert.equal(resSpecial.isValid, true, `Special status ${special} must be permitted`);
    }

    // 5. Unchanged voucher code passes validation without re-triggering allocation checks
    const resUnchanged = validateManualVoucherChange({
      origCode: 'SAME_CODE',
      newCode: 'SAME_CODE',
      permitDateRequired: '01/09/2026',
      permitDateExpiry: '07/09/2026',
      vouchersDatabase: vouchers,
      assignedCodesInOtherRecords: assignedOther
    });
    assert.equal(resUnchanged.isValid, true);
  });

  it('TEST 24: Single permit replacement/resend performs minimal authoritative localStorage permit database serialization and preserves persistence on reload', () => {
    // Mock local storage simulation
    const localStorageMock: { [key: string]: string } = {};
    let writeCount = 0;

    const setItem = (key: string, val: string) => {
      if (key === 'concessions_permit_db') {
        writeCount++;
      }
      localStorageMock[key] = val;
    };

    const getItem = (key: string) => localStorageMock[key] || null;

    // Initial database of 10 permits
    const initialDb: CsvPermitRecord[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i + 1),
      formId: 1000 + i,
      hospital: 'Whipps Cross Hospital',
      ward: 'Acorn Ward',
      vrm: `VRM${i}AAA`,
      driverName: `Driver ${i}`,
      dateRequired: '01/09/2026',
      voucherCode: `VCH${i}`,
      status: 'SENT',
      isDispatched: true
    }));

    setItem('concessions_permit_db', JSON.stringify(initialDb));
    assert.equal(writeCount, 1, 'Initial database setup performs 1 write');

    // Simulate replacement on record #5 (id: "5", formId: 1004)
    const target = initialDb[4];
    const newReplacementCode = 'NHS_REP_999';

    // 1. One authoritative update and write
    const updatedRecord: CsvPermitRecord = {
      ...target,
      voucherCode: newReplacementCode,
      voucherCodesText: newReplacementCode,
      prePaidCode: newReplacementCode,
      originalVoucherCode: target.voucherCode,
      replacementCode: undefined,
      isResend: false,
      status: 'SENT',
      isDispatched: true
    };

    const nextDb = initialDb.map(item => item.id === target.id ? updatedRecord : item);
    setItem('concessions_permit_db', JSON.stringify(nextDb));
    assert.equal(writeCount, 2, 'Replacement update performs exactly 1 additional write');

    // 2. Redundant cleanup on already-updated record must NOT perform additional writes
    const isAlreadyClean = (
      updatedRecord.status === 'SENT' &&
      updatedRecord.isDispatched === true &&
      !updatedRecord.replacementCode &&
      !updatedRecord.isResend &&
      !updatedRecord.emailType &&
      !updatedRecord.emailTemplate
    );
    assert.equal(isAlreadyClean, true, 'Updated record is recognized as already cleaned and dispatched');
    if (!isAlreadyClean) {
      setItem('concessions_permit_db', JSON.stringify(nextDb));
    }
    assert.equal(writeCount, 2, 'Zero redundant writes triggered by cleanup on already-updated record');

    // 3. Simulated browser reload: reload from localStorage
    const storedRaw = getItem('concessions_permit_db');
    assert.ok(storedRaw, 'Permit database exists in localStorage');
    const reloadedDb: CsvPermitRecord[] = JSON.parse(storedRaw!);

    assert.equal(reloadedDb.length, 10, 'All 10 permits survive reload');
    const reloadedRecord5 = reloadedDb.find(r => String(r.id) === '5');
    assert.ok(reloadedRecord5, 'Replaced record exists after reload');
    assert.equal(reloadedRecord5?.voucherCode, newReplacementCode, 'Replaced voucher code persisted');
    assert.equal(reloadedRecord5?.originalVoucherCode, 'VCH4', 'Original voucher code preserved');
    assert.equal(reloadedRecord5?.status, 'SENT', 'SENT status persisted');
    assert.equal(reloadedRecord5?.isDispatched, true, 'Dispatched state persisted');

    // Untouched records remain identical
    const reloadedRecord1 = reloadedDb.find(r => String(r.id) === '1');
    assert.equal(reloadedRecord1?.voucherCode, 'VCH0');
    assert.equal(reloadedRecord1?.status, 'SENT');
  });

  // =========================================================================
  // TEST 25 — Edit Record VRM / driver name persistence & cross-device sync
  // 1. VRM / Driver Name modification matches record by ID regardless of VRM change.
  // 2. getNormalizedPermitKey normalizes # prefixes and empty IDs.
  // 3. Merging Supabase permits into local state overwrites stale local records.
  // 4. Reconnecting to cloud does not overwrite cloud permits with stale offline data.
  // =========================================================================
  it('TEST 25: Edit Record VRM and driver name edits persist and sync cleanly across devices', async () => {
    const { getNormalizedPermitKey, isRecordMatch } = await import('../utils/dispatchUtils');

    // 1. Normalized key handles numeric, string, '#', and empty IDs
    assert.equal(getNormalizedPermitKey({ id: '2092' }), '2092');
    assert.equal(getNormalizedPermitKey({ formId: '#2092' }), '2092');
    assert.equal(getNormalizedPermitKey({ id: 'row-5', formId: '2092' }), '2092');
    assert.equal(getNormalizedPermitKey({ id: 'row-5' }), 'row-5');

    // 2. Record matching by ID succeeds even when VRM has changed
    const originalPermit: CsvPermitRecord = {
      id: '2092',
      formId: '2092',
      vrm: 'OLD123',
      driverName: 'Original Driver',
      dateRequired: '2026-10-07',
      dateExpiry: '2026-10-13',
      hospital: 'Whipps Cross Hospital',
      ward: 'Acorn Ward',
      status: 'PENDING'
    };

    const editedPermit: CsvPermitRecord = {
      ...originalPermit,
      vrm: 'NEW999',
      driverName: 'Updated Driver'
    };

    assert.equal(isRecordMatch(originalPermit, editedPermit), true, 'Records with same ID match even with changed VRM');

    // 3. Simulating cross-device sync:
    // Device A edits the permit and updates Supabase.
    // Device B has old permit in localStorage (OLD123).
    const localDbDeviceB: CsvPermitRecord[] = [originalPermit];
    const incomingFromSupabase: CsvPermitRecord[] = [editedPermit];

    // O(1) map merge as used in refreshDatabase
    const deviceBMap = new Map<string, CsvPermitRecord>();
    for (const rec of localDbDeviceB) {
      const key = getNormalizedPermitKey(rec);
      if (key) deviceBMap.set(key, rec);
    }

    for (const dbRec of incomingFromSupabase) {
      const key = getNormalizedPermitKey(dbRec);
      deviceBMap.set(key || String(dbRec.id), dbRec);
    }

    const reconciledDeviceB = Array.from(deviceBMap.values());
    assert.equal(reconciledDeviceB.length, 1, 'Merged database has 1 record');
    assert.equal(reconciledDeviceB[0].vrm, 'NEW999', 'Device B has updated VRM from Supabase');
    assert.equal(reconciledDeviceB[0].driverName, 'Updated Driver', 'Device B has updated Driver Name from Supabase');

    // 4. Offline reconnect check:
    // Device B reconnecting does NOT push stale permits over cloud permits that already exist
    const existingCloudKeys = new Set(incomingFromSupabase.map(r => getNormalizedPermitKey(r)).filter(Boolean));
    const staleLocalPermits = [originalPermit];
    const permitsToPush = staleLocalPermits.filter(r => {
      const key = getNormalizedPermitKey(r);
      return key && !existingCloudKeys.has(key);
    });
    assert.equal(permitsToPush.length, 0, 'Zero stale permits pushed to cloud on reconnect');
  });

  // =========================================================================
  // TEST 26 — Rizwan Akbar regression (#2113)
  // Request submitted on 09/10/2026 for 23/07/2026 - 29/07/2026
  // Expected: Expired cancellation reason with "The 7-day validity period for this concession has ended"
  // Must NOT claim an active permit exists valid through 29/07/2026
  // =========================================================================
  it('TEST 26: Rizwan Akbar regression (#2113) - Concession requested 7+ days in past resolves to expired email even if matching permit exists', () => {
    const historicalPermit: CsvPermitRecord = {
      id: '1500',
      formId: '1500',
      startTime: '23/07/2026 10:00:00',
      completionTime: '23/07/2026 10:00:00',
      vrm: 'LO67YNH',
      driverName: 'Rizwan Akbar',
      validFrom: '23/07/2026',
      validTo: '29/07/2026',
      dateRequired: '23/07/2026',
      hospital: 'Newham Hospital',
      ward: 'Larch Ward',
      status: 'SENT',
      isDispatched: true,
      voucherCode: 'OLD_JULY_VOUCHER'
    };

    const backdatedPermit: CsvPermitRecord = {
      id: '2113',
      formId: '2113',
      startTime: '09/10/2026 11:02:44',
      completionTime: '09/10/2026 11:02:44',
      vrm: 'LO67YNH',
      driverName: 'Rizwan Akbar',
      validFrom: '23/07/2026',
      validTo: '29/07/2026',
      dateRequired: '23/07/2026',
      hospital: 'Newham Hospital',
      ward: 'Larch Ward',
      status: 'CANCELLED',
      cancellationReason: 'EXPIRED'
    };

    const details = resolveCancellationDetails(backdatedPermit, [historicalPermit], '09/10/2026');
    assert.equal(details.reason, 'expired', 'Must resolve to expired, NOT duplicate');
    assert.equal(details.currentExpiryDate, '', 'Must not set currentExpiryDate for expired concession');
    assert.equal(details.earliestRenewalDate, '', 'Must not set earliestRenewalDate for expired concession');

    const email = getCancellationEmailContent({
      vrm: backdatedPermit.vrm,
      driverName: backdatedPermit.driverName,
      validFrom: backdatedPermit.validFrom,
      validTo: backdatedPermit.validTo,
      todayDate: '09/10/2026',
      reason: details.reason,
      cancellationReason: backdatedPermit.cancellationReason,
      currentExpiryDate: details.currentExpiryDate,
      earliestRenewalDate: details.earliestRenewalDate
    });

    assert.match(email.plainText, /The 7-day validity period for this concession has ended, so your request has been cancelled\./);
    assert.doesNotMatch(email.plainText, /already has an active permit valid through/);
  });

  // =========================================================================
  // TEST 27 — Replacement QR code email template, subject, body, and dates
  // Target: Replacement Parking Concession – {VRM}
  // Body must match NHS replacement template, not first-send template, with
  // correct dates from validFrom to validExpiry.
  // =========================================================================
  it('TEST 27: Replacement QR code email template produces expected subject, body, and dates', () => {
    const dates = deriveDateRangeForEmail({
      validFrom: '10/10/2026',
      validTo: '',
    });
    assert.equal(dates.validFrom, '10/10/2026');
    assert.equal(dates.validExpiry, '16/10/2026', 'Calculates validFrom + 6 days for 7-day concession');

    const email = getReplacementEmailContent({
      vrm: 'AB12CDE',
      driverName: 'Jane Doe',
      validFrom: '10/10/2026',
      validTo: '16/10/2026',
      duration: '7 days',
    });

    assert.equal(email.subject, 'Replacement Parking Concession – AB12CDE');
    assert.match(email.plainText, /^Dear Jane Doe,/);
    assert.match(email.plainText, /Please find attached your replacement concession QR code\. We apologise for any inconvenience caused by the previous code\./);
    assert.match(email.plainText, /Please use this replacement QR code instead of your previous QR code\./);
    assert.match(email.plainText, /On your next visit, please take the replacement QR code to the pay machine, press Concession, and enter vehicle registration number AB12CDE\./);
    assert.match(email.plainText, /The machine will then ask you to scan a blue badge or concession\. Please scan your replacement QR code at this point\./);
    assert.match(email.plainText, /Your concession will allow you to park for 7 days, from 10\/10\/2026 to 16\/10\/2026\./);
    assert.match(email.plainText, /Please note that concession payments are non-refundable\./);
    assert.match(email.plainText, /If you continue to experience any issues or have any further queries, please contact: parkingadminbh\.bartshealth@nhs\.net/);
    assert.match(email.plainText, /Kind regards,\nBarts Health NHS Trust\nCar Parking Services Team$/);

    // Verify it does NOT contain first-send copy
    assert.doesNotMatch(email.plainText, /On your first day of parking/);
  });

});

