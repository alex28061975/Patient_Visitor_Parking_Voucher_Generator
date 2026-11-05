import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { reconcileVoucherUpload } from '../utils/voucherReconcile';
import {
  getPermitVoucherWindow,
  getSelectableActiveDateCodes,
  getVoucherInventorySummary,
  getStockLevel,
  getCoverLevel,
  formatDateUK,
  excludeRecordOwnCodes
} from '../utils/voucherValidation';
import {
  ParsedVoucherData,
  CsvPermitRecord,
  isVoucherAvailableStatus
} from '../utils/csvParser';

describe('Voucher Upload Reconciliation & Withdrawal Test Suite (Scenarios A-G)', () => {

  it('TEST A: Upload file A (X, Y, Z for week W), then file B (X, Y for week W) -> Z becomes withdrawn and never allocated', () => {
    const existing: ParsedVoucherData[] = [
      { code: 'X', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false },
      { code: 'Y', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false },
      { code: 'Z', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false }
    ];

    const incoming: ParsedVoucherData[] = [
      { code: 'X', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false },
      { code: 'Y', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false }
    ];

    const { merged, withdrawnCount } = reconcileVoucherUpload(existing, incoming, []);
    assert.equal(withdrawnCount, 1);
    const zVoucher = merged.find(v => v.code === 'Z');
    assert.ok(zVoucher);
    assert.equal(zVoucher.status, 'withdrawn');
    assert.equal(zVoucher.isUsed, true);
    assert.equal(isVoucherAvailableStatus(zVoucher), false);
  });

  it('TEST B: Z assigned to a permit stays assigned and is reported in stalePermits', () => {
    const existing: ParsedVoucherData[] = [
      { code: 'X', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false },
      { code: 'Z', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false }
    ];

    const incoming: ParsedVoucherData[] = [
      { code: 'X', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false }
    ];

    const permit: CsvPermitRecord = {
      id: '101',
      formId: '101',
      vrm: 'ASSIGNED1',
      dateRequired: '2026-10-01',
      dateExpiry: '2026-10-07',
      voucherCode: 'Z',
      status: 'SENT',
      hospital: 'Whipps Cross Hospital',
      ward: 'Acorn',
      driverName: 'Driver'
    };

    const { merged, stalePermits } = reconcileVoucherUpload(existing, incoming, [permit]);
    assert.equal(stalePermits.length, 1);
    assert.equal(stalePermits[0].code, 'Z');
    const zVoucher = merged.find(v => v.code === 'Z');
    assert.ok(zVoucher);
    assert.equal(zVoucher.notInLatestExport, true);
    assert.equal(zVoucher.status, 'active');
  });

  it('TEST C: Vouchers from other weeks are untouched', () => {
    const existing: ParsedVoucherData[] = [
      { code: 'OTHER_WEEK_V', validFrom: '2026-09-21', validTo: '2026-09-27', status: 'active', isUsed: false }
    ];
    const incoming: ParsedVoucherData[] = [
      { code: 'X', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false }
    ];

    const { merged, withdrawnCount } = reconcileVoucherUpload(existing, incoming, []);
    assert.equal(withdrawnCount, 0);
    assert.equal(merged.length, 2);
    assert.equal(isVoucherAvailableStatus(merged[0]), true);
  });

  it('TEST D: Re-uploading a file containing Z un-withdraws it and clears flag', () => {
    const existing: ParsedVoucherData[] = [
      { code: 'Z', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'withdrawn', isUsed: true, notInLatestExport: true }
    ];
    const incoming: ParsedVoucherData[] = [
      { code: 'Z', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false }
    ];

    const { merged } = reconcileVoucherUpload(existing, incoming, []);
    const zVoucher = merged.find(v => v.code === 'Z');
    assert.ok(zVoucher);
    assert.equal(zVoucher.status, 'active');
    assert.equal(zVoucher.isUsed, false);
    assert.equal(zVoucher.notInLatestExport, false);
    assert.equal(isVoucherAvailableStatus(zVoucher), true);
  });

  it('TEST E: A replaced old code held in originalVoucherCode of a permit is not withdrawn', () => {
    const existing: ParsedVoucherData[] = [
      { code: 'OLD_CODE', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: true },
      { code: 'NEW_CODE', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false }
    ];
    const incoming: ParsedVoucherData[] = [
      { code: 'NEW_CODE', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false }
    ];
    const permit: CsvPermitRecord = {
      id: '200',
      formId: '200',
      vrm: 'REPLACED1',
      dateRequired: '2026-10-01',
      dateExpiry: '2026-10-07',
      voucherCode: 'NEW_CODE',
      originalVoucherCode: 'OLD_CODE',
      hospital: 'Hosp',
      ward: 'Ward',
      driverName: 'Driver'
    };

    const { merged, stalePermits } = reconcileVoucherUpload(existing, incoming, [permit]);
    const oldV = merged.find(v => v.code === 'OLD_CODE');
    assert.ok(oldV);
    assert.notEqual(oldV.status, 'withdrawn');
    assert.equal(stalePermits.some(s => s.code === 'OLD_CODE'), true);
  });

  it('TEST F: A code held only by a cancelled permit that was never sent IS withdrawn', () => {
    const existing: ParsedVoucherData[] = [
      { code: 'CANC_CODE', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false }
    ];
    const incoming: ParsedVoucherData[] = [
      { code: 'OTHER_CODE', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false }
    ];
    const permit: CsvPermitRecord = {
      id: '300',
      formId: '300',
      vrm: 'CANCVRM',
      dateRequired: '2026-10-01',
      dateExpiry: '2026-10-07',
      voucherCode: 'CANC_CODE',
      isCancelled: true,
      status: 'CANCELLED',
      hospital: 'Hosp',
      ward: 'Ward',
      driverName: 'Driver'
    };

    const { merged, withdrawnCount } = reconcileVoucherUpload(existing, incoming, [permit]);
    assert.equal(withdrawnCount, 1);
    const v = merged.find(v => v.code === 'CANC_CODE');
    assert.ok(v);
    assert.equal(v.status, 'withdrawn');
  });

  it('TEST G: Real Vouchers.csv structure test (code 4EVC59L5XJ3JL, permit 2432 VRM EA25VZM, date 27/10/2026)', () => {
    const existing: ParsedVoucherData[] = [
      { code: '4EVC59L5XJ3JL', validFrom: '2026-10-27', validTo: '2026-11-02', status: 'active', isUsed: false },
      { code: 'EXTRA_CODE', validFrom: '2026-10-27', validTo: '2026-11-02', status: 'active', isUsed: false }
    ];
    // incoming has other codes for that window, but NOT 4EVC59L5XJ3JL or EXTRA_CODE
    const incoming: ParsedVoucherData[] = [
      { code: 'OTHER_CODE_1', validFrom: '2026-10-27', validTo: '2026-11-02', status: 'active', isUsed: false }
    ];

    const permit: CsvPermitRecord = {
      id: '2432',
      formId: '2432',
      vrm: 'EA25VZM',
      dateRequired: '2026-10-27',
      dateExpiry: '2026-11-02',
      voucherCode: '4EVC59L5XJ3JL',
      status: 'SENT',
      hospital: 'Hosp',
      ward: 'Ward',
      driverName: 'Driver'
    };

    const { merged, withdrawnCount, stalePermits } = reconcileVoucherUpload(existing, incoming, [permit]);
    // EXTRA_CODE should be withdrawn (unassigned)
    // 4EVC59L5XJ3JL should NOT be withdrawn, but flagged notInLatestExport and in stalePermits
    assert.equal(withdrawnCount, 1);
    const extra = merged.find(v => v.code === 'EXTRA_CODE');
    assert.ok(extra);
    assert.equal(extra.status, 'withdrawn');

    const target = merged.find(v => v.code === '4EVC59L5XJ3JL');
    assert.ok(target);
    assert.equal(target.status, 'active');
    assert.equal(target.notInLatestExport, true);
    assert.equal(stalePermits.some(s => s.code === '4EVC59L5XJ3JL' && s.id === '2432'), true);
  });

  it('TEST H: App.tsx uses reconcileVoucherUpload and does not contain inline reconcile logic (stalePermitsList)', () => {
    const appPath = path.resolve(process.cwd(), 'src/App.tsx');
    const content = fs.readFileSync(appPath, 'utf8');

    assert.equal(content.includes('import { reconcileVoucherUpload }'), true);
    assert.equal(content.includes('reconcileVoucherUpload('), true);
    assert.equal(content.includes('stalePermitsList'), false);
  });

  it('TEST I: getPermitVoucherWindow unit tests (a-d) and Vouchers.csv week isolation', () => {
    // (a) {dateRequired:'01/11/2026', validTo:'2026-11-07'} gives 2026-11-01 to 2026-11-07
    const w1 = getPermitVoucherWindow({ dateRequired: '01/11/2026', validTo: '2026-11-07' } as any);
    assert.equal(w1.fromISO, '2026-11-01');
    assert.equal(w1.toISO, '2026-11-07');

    // (b) {dateRequired:'01/11/2026 to 07/11/2026'} gives 2026-11-01 to 2026-11-07
    const w2 = getPermitVoucherWindow({ dateRequired: '01/11/2026 to 07/11/2026' } as any);
    assert.equal(w2.fromISO, '2026-11-01');
    assert.equal(w2.toISO, '2026-11-07');

    // (c) no validTo gives from plus 6 days
    const w3 = getPermitVoucherWindow({ dateRequired: '01/11/2026' } as any);
    assert.equal(w3.fromISO, '2026-11-01');
    assert.equal(w3.toISO, '2026-11-07');

    // (d) a record with todayDate 2026-11-02 but dateRequired 01/11/2026 still gives 2026-11-01
    const w4 = getPermitVoucherWindow({ todayDate: '2026-11-02', dateRequired: '01/11/2026' } as any);
    assert.equal(w4.fromISO, '2026-11-01');
    assert.equal(w4.toISO, '2026-11-07');

    // Real structure of Vouchers.csv (30 vouchers per week): window 2026-11-01 to 2026-11-07 yields only the 01/11 batch codes (e.g. 1NJTIUGXSRJ17) and none of the 02/11 batch (e.g. OVYGRU0HIO0I1)
    const vouchers: ParsedVoucherData[] = [];
    for (let i = 1; i <= 30; i++) {
      vouchers.push({ code: `V1_${i}`, validFrom: '2026-11-01', validTo: '2026-11-07', status: 'active', isUsed: false });
    }
    vouchers.push({ code: 'OVYGRU0HIO0I1', validFrom: '2026-11-02', validTo: '2026-11-08', status: 'active', isUsed: false });
    vouchers[0].code = '1NJTIUGXSRJ17';

    const selectable = getSelectableActiveDateCodes({
      vouchersDatabase: vouchers,
      database: [],
      permitDateRequired: '2026-11-01',
      permitDateExpiry: '2026-11-07',
      currentRecord: { id: '1', dateRequired: '01/11/2026', validTo: '2026-11-07' } as any
    });

    assert.equal(selectable.some(v => v.code === '1NJTIUGXSRJ17'), true);
    assert.equal(selectable.some(v => v.code === 'OVYGRU0HIO0I1'), false);
  });

  it('TEST J: getVoucherInventorySummary breakdown, totalInWindow, availableInWindow, withdrawn and expired isolation', () => {
    const vouchers: ParsedVoucherData[] = [];
    for (let i = 1; i <= 29; i++) {
      vouchers.push({ code: `V_${i}`, validFrom: '2026-11-01', validTo: '2026-11-07', status: 'active', isUsed: false });
    }
    vouchers.push({ code: 'V_WITHDRAWN', validFrom: '2026-11-01', validTo: '2026-11-07', status: 'withdrawn', isUsed: true });
    vouchers.push({ code: 'V_EXPIRED', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false });

    const assigned = new Set(['V_1', 'V_2', 'V_3', 'V_4', 'V_5']);
    const summary = getVoucherInventorySummary(vouchers, assigned, '2026-11-01', '2026-11-07', '2026-11-04');

    assert.equal(summary.totalInWindow, 30);
    assert.equal(summary.availableInWindow, 24);
    const sumBreakdown = summary.breakdown.available + summary.breakdown.used + summary.breakdown.withdrawn + summary.breakdown.expired;
    assert.equal(sumBreakdown, vouchers.length);
    assert.equal(summary.breakdown.withdrawn, 1);
    assert.equal(summary.breakdown.expired, 1);
  });

  it('TEST K: getStockLevel and getCoverLevel unit tests', () => {
    assert.equal(getStockLevel(17), 'green');
    assert.equal(getStockLevel(10), 'amber');
    assert.equal(getStockLevel(1), 'amber');
    assert.equal(getStockLevel(0), 'red');

    assert.equal(getCoverLevel(20), 'green');
    assert.equal(getCoverLevel(7), 'amber');
    assert.equal(getCoverLevel(4), 'amber');
    assert.equal(getCoverLevel(3), 'red');
    assert.equal(getCoverLevel(0), 'red');
  });

  it('TEST L: Window chip text formatting for fromISO 2026-11-02 / toISO 2026-11-08', () => {
    const from = '2026-11-02';
    const to = '2026-11-08';
    const ukFrom = formatDateUK(from);
    const ukTo = formatDateUK(to);
    const shortFrom = ukFrom.substring(0, 5);
    const shortTo = ukTo.substring(0, 5);
    const text = `${shortFrom} – ${shortTo}`;
    assert.equal(text, '02/11 – 08/11');
  });

  it('TEST M: excludeRecordOwnCodes and VoucherCodePicker source checks', () => {
    const list: ParsedVoucherData[] = [
      { code: 'AAA111', validFrom: '2026-11-01', validTo: '2026-11-07', status: 'active', isUsed: false },
      { code: 'BBB222', validFrom: '2026-11-01', validTo: '2026-11-07', status: 'active', isUsed: false },
      { code: 'CCC333', validFrom: '2026-11-01', validTo: '2026-11-07', status: 'active', isUsed: false }
    ];

    const res1 = excludeRecordOwnCodes(list, { voucherCode: 'AAA111' } as any);
    assert.deepEqual(res1.map(v => v.code), ['BBB222', 'CCC333']);

    const res2 = excludeRecordOwnCodes(list, {
      voucherCode: 'BBB222',
      originalVoucherCode: 'AAA111',
      replacementCode: 'BBB222'
    } as any);
    assert.deepEqual(res2.map(v => v.code), ['CCC333']);

    const res3 = excludeRecordOwnCodes(list, {} as any);
    assert.deepEqual(res3.map(v => v.code), ['AAA111', 'BBB222', 'CCC333']);

    const pickerPath = path.resolve(process.cwd(), 'src/components/VoucherCodePicker.tsx');
    const pickerContent = fs.readFileSync(pickerPath, 'utf8');
    assert.equal(pickerContent.includes('value={value}'), false);
    assert.equal(pickerContent.includes('value: string'), false);
    assert.equal(pickerContent.includes('Copy'), false);
    assert.equal(pickerContent.includes('Check'), false);
  });

});
