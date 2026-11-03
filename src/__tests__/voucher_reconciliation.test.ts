import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { reconcileVoucherUpload } from '../utils/voucherReconcile';
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

});
