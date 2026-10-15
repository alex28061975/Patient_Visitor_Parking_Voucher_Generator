import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { autoCancelDuplicates } from '../App';
import { CsvPermitRecord } from '../utils/csvParser';

function makeBasePermit(overrides: Partial<CsvPermitRecord> & { id: string; vrm: string }): CsvPermitRecord {
  return {
    formId: overrides.id,
    hospital: 'Whipps Cross Hospital',
    ward: 'Acorn Ward',
    driverName: 'Test Driver',
    dateRequired: overrides.validFrom || '14/10/2026',
    ...overrides
  };
}

describe('Cancellation Reason Persistence & Reinstatement Test Suite', () => {
  it('a) #2168 MANUAL cancelled and #2187 DUPLICATE_VRM cancelled: #2168 stays MANUAL, #2187 becomes ACTIVE', () => {
    const r2168 = makeBasePermit({
      id: '2168',
      startTime: '12/10/2026 19:36:04',
      vrm: 'LA17EPY',
      validFrom: '15/10/2026',
      validTo: '21/10/2026',
      dateRequired: '15/10/2026',
      status: 'CANCELLED',
      isCancelled: true,
      voucherCode: 'CANCELLED',
      prePaidCode: 'CANCELLED',
      cancellationReason: 'MANUAL'
    });

    const r2187 = makeBasePermit({
      id: '2187',
      startTime: '14/10/2026 13:03:47',
      vrm: 'LA17EPY',
      validFrom: '14/10/2026',
      validTo: '20/10/2026',
      dateRequired: '14/10/2026',
      status: 'CANCELLED',
      isCancelled: true,
      cancellationReason: 'DUPLICATE_VRM'
    });

    const reconciled = autoCancelDuplicates([r2168, r2187]);
    assert.equal(reconciled[0].status, 'CANCELLED');
    assert.equal(reconciled[0].cancellationReason, 'MANUAL');
    assert.equal(reconciled[1].status, 'ACTIVE');
    assert.equal(reconciled[1].isCancelled, false);
    assert.equal(reconciled[1].cancellationReason, undefined);
  });

  it('b) Same, but #2187 has no cancellationReason: #2187 becomes ACTIVE', () => {
    const r2168 = makeBasePermit({
      id: '2168',
      startTime: '12/10/2026 19:36:04',
      vrm: 'LA17EPY',
      validFrom: '15/10/2026',
      validTo: '21/10/2026',
      dateRequired: '15/10/2026',
      status: 'CANCELLED',
      isCancelled: true,
      voucherCode: 'CANCELLED',
      prePaidCode: 'CANCELLED',
      cancellationReason: 'MANUAL'
    });

    const r2187 = makeBasePermit({
      id: '2187',
      startTime: '14/10/2026 13:03:47',
      vrm: 'LA17EPY',
      validFrom: '14/10/2026',
      validTo: '20/10/2026',
      dateRequired: '14/10/2026',
      status: 'CANCELLED',
      isCancelled: true
    });

    const reconciled = autoCancelDuplicates([r2168, r2187]);
    assert.equal(reconciled[0].status, 'CANCELLED');
    assert.equal(reconciled[0].cancellationReason, 'MANUAL');
    assert.equal(reconciled[1].status, 'ACTIVE');
    assert.equal(reconciled[1].isCancelled, false);
  });

  it('c) Both records active and overlapping: output[1] is CANCELLED with reason DUPLICATE_VRM', () => {
    const r2168 = makeBasePermit({
      id: '2168',
      startTime: '12/10/2026 19:36:04',
      vrm: 'LA17EPY',
      validFrom: '15/10/2026',
      validTo: '21/10/2026',
      dateRequired: '15/10/2026',
      status: 'ACTIVE',
      isCancelled: false
    });

    const r2187 = makeBasePermit({
      id: '2187',
      startTime: '14/10/2026 13:03:47',
      vrm: 'LA17EPY',
      validFrom: '14/10/2026',
      validTo: '20/10/2026',
      dateRequired: '14/10/2026',
      status: 'ACTIVE',
      isCancelled: false
    });

    const reconciled = autoCancelDuplicates([r2168, r2187]);
    assert.equal(reconciled[0].status, 'ACTIVE');
    assert.equal(reconciled[1].status, 'CANCELLED');
    assert.equal(reconciled[1].cancellationReason, 'DUPLICATE_VRM');
  });
});
