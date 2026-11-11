import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { getRowState, resolveEditRecordStatus, buildReplacementRecord } from '../utils/dispatchUtils';
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
    const permitCardSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/PermitCard.tsx'), 'utf8');
    const appSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const dispatchUtilsSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/utils/dispatchUtils.ts'), 'utf8');

    // DispatchCentre.tsx does NOT contain "!isDisp && isReplacementPending(record)"
    assert.equal(dispatchCentreSrc.includes('!isDisp && isReplacementPending(record)'), false);

    // DispatchCentre.tsx DOES contain "getRowState({ isBlocked, isCancelled, isDispatched, replacementPending }).actionLabel"
    assert.equal(dispatchCentreSrc.includes('getRowState({ isBlocked, isCancelled, isDispatched, replacementPending }).actionLabel'), true);

    // EditRecordModal and Choose a code share the same explicit replacement transition.
    assert.ok(editModalSrc.includes('buildExplicitReplacementState'));
    assert.ok(dispatchUtilsSrc.includes('export function buildExplicitReplacementState'));

    // Row selection must not feed selectedRowRecord replacement metadata into the badge logic.
    assert.equal(dispatchCentreSrc.includes('selectedRowRecord?.replacementCode'), false);

    // Legacy flags and original-code comparisons must not independently activate replacement mode.
    assert.equal(permitCardSrc.includes('data.emailType === "RESEND_CONCESSION"'), false);
    assert.equal(permitCardSrc.includes('data.isResend ||'), false);
    assert.equal(permitCardSrc.includes('targetRec.emailType === "RESEND_CONCESSION"'), false);
    assert.equal(permitCardSrc.includes('targetRec.originalVoucherCode && targetPayloadCode'), false);

    // App hydration and selection must not infer replacement from legacy flags.
    assert.ok(appSrc.includes('const isRep = Boolean(next.replacementCode);'));
    assert.equal(appSrc.includes('localMatch.replacementCode || localMatch.isResend'), false);
    assert.ok(appSrc.includes('No replacement code has been explicitly assigned. Use Choose a code or EDIT first.'));
    assert.equal(appSrc.includes('const availableUnused = (vouchersDatabaseRef.current || []).find'), false);

    // EditRecordModal.tsx does NOT contain "isCancelled, dispatchedKeys, unsentKeys]"
    assert.equal(editModalSrc.includes('isCancelled, dispatchedKeys, unsentKeys]'), false);

    // Source check: handleActiveDateCodeSelect calls onSaveRecord and no longer calls onChangeFormData
    assert.ok(dispatchCentreSrc.includes('onSaveRecord?.(updatedRecord)'));
    assert.equal(dispatchCentreSrc.includes('onChangeFormData?.(buildReplacementFormUpdate'), false);
  });

  it('buildReplacementRecord and field preservation tests', () => {
    const permit = {
      id: '1',
      voucherCode: 'ORIG_VOUCHER',
      prePaidCode: 'ORIG_VOUCHER',
      status: 'SENT'
    };
    const rep1 = buildReplacementRecord(permit, 'REP_CODE_1');
    assert.equal(rep1.replacementCode, 'REP_CODE_1');
    assert.equal(rep1.originalVoucherCode, 'ORIG_VOUCHER');
    assert.equal(rep1.isResend, true);
    assert.equal(rep1.emailType, 'RESEND_CONCESSION');
    assert.equal(rep1.emailTemplate, 'replacement');
    assert.equal(rep1.status, 'SENT');
    assert.equal(rep1.voucherCode, 'ORIG_VOUCHER');

    // Second replacement keeping the FIRST original code
    const rep2 = buildReplacementRecord(rep1, 'REP_CODE_2');
    assert.equal(rep2.replacementCode, 'REP_CODE_2');
    assert.equal(rep2.originalVoucherCode, 'ORIG_VOUCHER');
    assert.equal(rep2.status, 'SENT');
    assert.equal(rep2.voucherCode, 'ORIG_VOUCHER');
  });

});
