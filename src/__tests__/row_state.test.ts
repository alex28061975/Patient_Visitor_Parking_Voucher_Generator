import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { getRowState, resolveEditRecordStatus } from '../utils/dispatchUtils';
import { CsvPermitRecord } from '../utils/csvParser';

describe('Row State & Edit Status Test Suite (row_state.test.ts)', () => {

  it('getRowState behavior tests', () => {
    // 1. Dispatched + replacementPending => REPLACEMENT / Resend
    const res1 = getRowState({ isDispatched: true, replacementPending: true });
    assert.equal(res1.status, 'REPLACEMENT');
    assert.equal(res1.actionLabel, 'Resend');

    // 2. Dispatched only => SENT / Unsend
    const res2 = getRowState({ isDispatched: true, replacementPending: false });
    assert.equal(res2.status, 'SENT');
    assert.equal(res2.actionLabel, 'Unsend');

    // 3. Nothing => PENDING / Send
    const res3 = getRowState({});
    assert.equal(res3.status, 'PENDING');
    assert.equal(res3.actionLabel, 'Send');

    // 4. Blocked always wins
    const resBlocked = getRowState({ isBlocked: true, isDispatched: true, replacementPending: true });
    assert.equal(resBlocked.status, 'BLOCKED');
    assert.equal(resBlocked.actionLabel, 'Blocked');

    // 5. Cancelled always wins
    const resCancelled = getRowState({ isCancelled: true, isDispatched: true, replacementPending: true });
    assert.equal(resCancelled.status, 'CANCELLED');
    assert.equal(resCancelled.actionLabel, 'Unsend'); // isDispatched true -> Unsend

    // 6. Cancelled with isDispatched false -> Send
    const resCancelledNotDisp = getRowState({ isCancelled: true, isDispatched: false });
    assert.equal(resCancelledNotDisp.status, 'CANCELLED');
    assert.equal(resCancelledNotDisp.actionLabel, 'Send');
  });

  it('resolveEditRecordStatus behavior tests', () => {
    const permit: CsvPermitRecord = {
      id: '10',
      formId: '1000',
      vrm: 'TESTVRM',
      dateRequired: '2026-10-01',
      hospital: 'Whipps Cross Hospital',
      ward: 'Acorn Ward',
      driverName: 'Test Driver'
    };

    // 'Pending' / 'pending' / undefined => PENDING
    assert.equal(resolveEditRecordStatus({ ...permit, status: 'Pending' }, [], []), 'PENDING');
    assert.equal(resolveEditRecordStatus({ ...permit, status: 'pending' }, [], []), 'PENDING');
    assert.equal(resolveEditRecordStatus({ ...permit, status: undefined }, [], []), 'PENDING');

    // 'Sent' / 'Dispatched' / isDispatched => SENT
    assert.equal(resolveEditRecordStatus({ ...permit, status: 'Sent' }, ['1000'], []), 'SENT');
    assert.equal(resolveEditRecordStatus({ ...permit, status: 'Dispatched' }, ['1000'], []), 'SENT');
    assert.equal(resolveEditRecordStatus({ ...permit, isDispatched: true }, [], []), 'SENT');

    // 'Unsent' => UNSENT
    assert.equal(resolveEditRecordStatus({ ...permit, status: 'Unsent' }, [], []), 'UNSENT');

    // 'Cancelled' => CANCELLED
    assert.equal(resolveEditRecordStatus({ ...permit, status: 'Cancelled' }, [], []), 'CANCELLED');
    assert.equal(resolveEditRecordStatus({ ...permit, isCancelled: true }, [], []), 'CANCELLED');

    // Explicit unsent beats a stale SENT status
    const staleSentPermit = { ...permit, status: 'SENT', formId: '1000' };
    assert.equal(resolveEditRecordStatus(staleSentPermit, ['1000'], ['1000']), 'UNSENT');

    // Another permit of the same driver / different formId being unsent does not make this permit UNSENT
    const otherPermitUnsentKeys = ['9999'];
    assert.equal(resolveEditRecordStatus(staleSentPermit, ['1000'], otherPermitUnsentKeys), 'SENT');
  });

  it('Source code checks', () => {
    const dispatchCentreSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/DispatchCentre.tsx'), 'utf8');
    const editModalSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/EditRecordModal.tsx'), 'utf8');

    // DispatchCentre.tsx does NOT contain "!isDisp && isReplacementPending(record)"
    assert.equal(dispatchCentreSrc.includes('!isDisp && isReplacementPending(record)'), false);

    // DispatchCentre.tsx DOES contain "getRowState({ isBlocked, isCancelled, isDispatched, replacementPending }).actionLabel"
    assert.equal(dispatchCentreSrc.includes('getRowState({ isBlocked, isCancelled, isDispatched, replacementPending }).actionLabel'), true);

    // EditRecordModal.tsx does NOT contain "isCancelled, dispatchedKeys, unsentKeys]"
    assert.equal(editModalSrc.includes('isCancelled, dispatchedKeys, unsentKeys]'), false);
  });

});
