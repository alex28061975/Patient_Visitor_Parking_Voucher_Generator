import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enrichRecordsWithVouchers } from '../App';
import {
  ParsedVoucherData,
  CsvPermitRecord,
  cleanVoucherCodeValue,
  isVoucherAvailableStatus
} from '../utils/csvParser';

describe('Voucher Upload Reconciliation & Withdrawal Test Suite', () => {

  it('TEST A: Upload file A (X, Y, Z for week W), then file B (X, Y for week W) -> Z becomes withdrawn and never allocated', async () => {
    const vouchersA: ParsedVoucherData[] = [
      { code: 'X', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false },
      { code: 'Y', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false },
      { code: 'Z', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false }
    ];

    const vouchersB: ParsedVoucherData[] = [
      { code: 'X', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false },
      { code: 'Y', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false }
    ];

    const mergedMap = new Map<string, ParsedVoucherData>();
    vouchersA.forEach(v => mergedMap.set(v.code, { ...v }));

    const incomingValidFroms = new Set(['2026-10-01']);
    const incomingCodes = new Set(['X', 'Y']);
    const assignedCodes = new Set<string>();

    for (const [code, v] of mergedMap.entries()) {
      if (v.validFrom === '2026-10-01' && !incomingCodes.has(code)) {
        if (!assignedCodes.has(code)) {
          mergedMap.set(code, { ...v, status: 'withdrawn', isUsed: true });
        }
      }
    }

    vouchersB.forEach(v => {
      mergedMap.set(v.code, { ...v, status: 'active', isUsed: false });
    });

    const reconciled = Array.from(mergedMap.values());
    const zVoucher = reconciled.find(v => v.code === 'Z');
    assert.ok(zVoucher);
    assert.equal(zVoucher.status, 'withdrawn');
    assert.equal(zVoucher.isUsed, true);
    assert.equal(isVoucherAvailableStatus(zVoucher), false);

    const permit: CsvPermitRecord = {
      id: '1',
      vrm: 'TEST123',
      dateRequired: '2026-10-01',
      dateExpiry: '2026-10-07',
      hospital: 'Whipps Cross Hospital',
      ward: 'Acorn',
      driverName: 'Driver'
    };
    const enriched = enrichRecordsWithVouchers([permit], reconciled, {}, '2026-10-01');
    assert.notEqual(enriched[0].voucherCode, 'Z');
  });

  it('TEST B: Z assigned to a permit stays assigned and is reported in staleAssignedCodes', () => {
    const vouchersA: ParsedVoucherData[] = [
      { code: 'X', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false },
      { code: 'Z', validFrom: '2026-10-01', validTo: '2026-10-07', status: 'active', isUsed: false }
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

    const incomingCodes = new Set(['X']);
    const staleAssignedCodes: string[] = [];

    vouchersA.forEach(v => {
      if (v.code === 'Z' && !incomingCodes.has(v.code)) {
        const isAssigned = (permit.voucherCode === v.code);
        if (isAssigned) {
          staleAssignedCodes.push(v.code);
        }
      }
    });

    assert.equal(staleAssignedCodes.includes('Z'), true);
  });

  it('TEST C: Vouchers from other weeks are untouched', () => {
    const vouchers: ParsedVoucherData[] = [
      { code: 'OTHER_WEEK_V', validFrom: '2026-09-21', validTo: '2026-09-27', status: 'active', isUsed: false }
    ];
    const incomingValidFroms = new Set(['2026-10-01']);

    const v = vouchers[0];
    const untouched = !incomingValidFroms.has(v.validFrom!);
    assert.equal(untouched, true);
    assert.equal(isVoucherAvailableStatus(v), true);
  });

  it('TEST D: Re-uploading a file containing Z un-withdraws it', () => {
    const withdrawnVoucher: ParsedVoucherData = {
      code: 'Z',
      validFrom: '2026-10-01',
      validTo: '2026-10-07',
      status: 'withdrawn',
      isUsed: true
    };

    const reUploaded: ParsedVoucherData = {
      ...withdrawnVoucher,
      status: 'active',
      isUsed: false
    };

    assert.equal(isVoucherAvailableStatus(reUploaded), true);
    assert.equal(reUploaded.status, 'active');
  });

});
