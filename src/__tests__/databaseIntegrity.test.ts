import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  cleanVoucherCodeValue,
  parseDateToISO,
  addDaysSafe,
  isVoucherExactPeriodEligible,
  ParsedVoucherData
} from '../utils/csvParser';
import { getRecordPrimaryKey, getRecordKeys } from '../utils/dispatchUtils';

describe('ParkPass Database Integrity & Security Audit Suite', () => {

  const rootDir = process.cwd();
  const masterSqlPath = path.join(rootDir, 'master_schema_and_security.sql');
  const supabaseSqlPath = path.join(rootDir, 'supabase_schema.sql');

  // =========================================================================
  // AUDIT 1 — Master Schema DDL Integrity
  // Verifies tables, columns, primary keys, and performance indexes
  // =========================================================================
  it('AUDIT 1: master_schema_and_security.sql defines required tables, primary keys, and columns', () => {
    assert.ok(fs.existsSync(masterSqlPath), 'master_schema_and_security.sql must exist');
    const sql = fs.readFileSync(masterSqlPath, 'utf8');

    // 1. Permits Table
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.permits/i);
    assert.match(sql, /id TEXT PRIMARY KEY/i);
    assert.match(sql, /hospital TEXT/i);
    assert.match(sql, /ward TEXT/i);
    assert.match(sql, /date_required TEXT/i);
    assert.match(sql, /date_expiry TEXT/i);
    assert.match(sql, /vrm TEXT/i);
    assert.match(sql, /driver_name TEXT/i);
    assert.match(sql, /voucher_code TEXT/i);
    assert.match(sql, /start_time TEXT/i);
    assert.match(sql, /completion_time TEXT/i);

    // 2. Vouchers Table
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.vouchers/i);
    assert.match(sql, /code TEXT PRIMARY KEY/i);
    assert.match(sql, /valid_from TEXT/i);
    assert.match(sql, /valid_to TEXT/i);

    // 3. Dispatched History Table
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.dispatched_history/i);
    assert.match(sql, /key TEXT PRIMARY KEY/i);
    assert.match(sql, /dispatch_date TEXT/i);
    assert.match(sql, /dispatch_by TEXT/i);

    // 4. Performance Indexes
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_permits_vrm ON public\.permits\s*\(vrm\)/i);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_permits_date_required ON public\.permits\s*\(date_required\)/i);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_vouchers_vrm ON public\.vouchers\s*\(vrm\)/i);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_dispatched_history_vrm ON public\.dispatched_history\s*\(vrm\)/i);
  });

  // =========================================================================
  // AUDIT 2 — Row Level Security (RLS) & Role-Scoped Policies
  // Verifies RLS is enabled on all tables and no unrestricted ALL policies exist
  // =========================================================================
  it('AUDIT 2: RLS is enforced on all tables with explicit authenticated role policies', () => {
    const sql = fs.readFileSync(masterSqlPath, 'utf8');

    // RLS enabled
    assert.match(sql, /ALTER TABLE public\.permits ENABLE ROW LEVEL SECURITY;/i);
    assert.match(sql, /ALTER TABLE public\.vouchers ENABLE ROW LEVEL SECURITY;/i);
    assert.match(sql, /ALTER TABLE public\.dispatched_history ENABLE ROW LEVEL SECURITY;/i);

    // Cleanup of dangerous overly permissive policies
    assert.match(sql, /DROP POLICY IF EXISTS "Allow public all on permits"/i);
    assert.match(sql, /DROP POLICY IF EXISTS "Allow public all on vouchers"/i);
    assert.match(sql, /DROP POLICY IF EXISTS "Allow public all on dispatched_history"/i);

    // Explicit authenticated role check on permits
    assert.match(sql, /CREATE POLICY "permits_select_authenticated"[\s\S]*?TO authenticated[\s\S]*?USING \(auth\.role\(\) = 'authenticated'\);/i);
    assert.match(sql, /CREATE POLICY "permits_insert_authenticated"[\s\S]*?TO authenticated[\s\S]*?WITH CHECK \(auth\.role\(\) = 'authenticated'\);/i);

    // Explicit authenticated role check on vouchers
    assert.match(sql, /CREATE POLICY "vouchers_select_authenticated"[\s\S]*?TO authenticated[\s\S]*?USING \(auth\.role\(\) = 'authenticated'\);/i);

    // Explicit authenticated role check on dispatched_history
    assert.match(sql, /CREATE POLICY "dispatched_history_select_authenticated"[\s\S]*?TO authenticated[\s\S]*?USING \(auth\.role\(\) = 'authenticated'\);/i);
  });

  // =========================================================================
  // AUDIT 3 — Secure RPC Function & Execution Privileges
  // Verifies search_path pinning and service_role isolation on log_dispatch
  // =========================================================================
  it('AUDIT 3: log_dispatch RPC is hardened with search_path pinning and restricted execution', () => {
    const sql = fs.readFileSync(masterSqlPath, 'utf8');

    // SECURITY DEFINER and pinned search path
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.log_dispatch/i);
    assert.match(sql, /SECURITY DEFINER/i);
    assert.match(sql, /SET search_path = public, pg_temp/i);

    // Restricted execution: revoked from anon/public/authenticated, granted to service_role
    assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.log_dispatch\(TEXT, TEXT, TEXT, TEXT, TEXT\) FROM public, anon, authenticated;/i);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.log_dispatch\(TEXT, TEXT, TEXT, TEXT, TEXT\) TO service_role;/i);
  });

  // =========================================================================
  // AUDIT 4 — Future Table Protection Trigger
  // Verifies rls_auto_enable event trigger exists for automated future hardening
  // =========================================================================
  it('AUDIT 4: rls_auto_enable event trigger is defined to safeguard any new tables', () => {
    const sql = fs.readFileSync(masterSqlPath, 'utf8');

    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.rls_auto_enable\(\)/i);
    assert.match(sql, /SET search_path = pg_catalog, pg_temp/i);
    assert.match(sql, /CREATE EVENT TRIGGER tr_auto_enable_rls/i);
    assert.match(sql, /ON ddl_command_end/i);
    assert.match(sql, /WHEN TAG IN \('CREATE TABLE'\)/i);
  });

  // =========================================================================
  // AUDIT 5 — Primary Key & Dispatch Key Anchor Integrity
  // Protects against record collision and verifies non-empty deterministic keys
  // =========================================================================
  it('AUDIT 5: Record primary keys are deterministic, non-empty, and correctly prioritized', () => {
    // 1. formId takes absolute precedence when present
    const recordWithFormId = {
      id: 'legacy_uuid_123',
      formId: 1914,
      vrm: 'EA25VZM',
      hospital: 'Whipps Cross Hospital',
      ward: 'Maternity',
      dateRequired: '27/09/2026',
      driverName: 'Driver'
    };
    const key1 = getRecordPrimaryKey(recordWithFormId);
    assert.equal(key1, '1914', 'Numeric formId must be converted to string and used as primary key');

    // 2. id fallback when formId is missing
    const recordWithoutFormId = {
      id: 'permit_row_88',
      vrm: 'AB12CDE',
      hospital: 'Whipps Cross Hospital',
      ward: 'Ward 2',
      dateRequired: '20/09/2026',
      driverName: 'Driver'
    };
    const key2 = getRecordPrimaryKey(recordWithoutFormId);
    assert.equal(key2, 'permit_row_88');

    // 3. VRM alias isolation
    const keys = getRecordKeys(recordWithFormId);
    assert.ok(keys.includes('1914'));
    assert.ok(!keys.includes('EA25VZM'), 'Aliases must not include bare VRM to prevent cross-permit collisions');
  });

  // =========================================================================
  // AUDIT 6 — Voucher Code Sanitization & Expiration Period Invariants
  // Verifies that dirty voucher strings are cleaned and invalid dates are rejected
  // =========================================================================
  it('AUDIT 6: Voucher codes are sanitized and date range matching adheres to strict boundaries', () => {
    // Voucher cleaning
    assert.equal(cleanVoucherCodeValue('  5leumnspvmxsv  '), '5LEUMNSPVMXSV');
    assert.equal(cleanVoucherCodeValue('CANCELLED'), '-');
    assert.equal(cleanVoucherCodeValue('-'), '-');
    assert.equal(cleanVoucherCodeValue(''), '-');
    assert.equal(cleanVoucherCodeValue(undefined), '-');

    // Voucher date range eligibility
    const testVoucher: ParsedVoucherData = {
      code: 'VALID_20_26',
      validFrom: '20/09/2026',
      validTo: '26/09/2026',
      status: 'AVAILABLE'
    };

    assert.equal(isVoucherExactPeriodEligible(testVoucher, '20/09/2026', '26/09/2026'), true, 'Exact match must be eligible');
    assert.equal(isVoucherExactPeriodEligible(testVoucher, '19/09/2026', '25/09/2026'), false, 'Earlier date must NOT be eligible');
    assert.equal(isVoucherExactPeriodEligible(testVoucher, '21/09/2026', '27/09/2026'), false, 'Later date must NOT be eligible');
    assert.equal(isVoucherExactPeriodEligible(testVoucher, '27/09/2026', '03/10/2026'), false, 'Adjacent date must NOT be eligible');
  });

  // =========================================================================
  // AUDIT 7 — Date Arithmetic & Concession Span Invariants
  // Verifies that a 7-day concession period is consistently calculated across month ends
  // =========================================================================
  it('AUDIT 7: 7-day concession periods correctly calculate end date across calendar months', () => {
    // 20/09/2026 (Day 1) + 6 days = 2026-09-26 (Day 7 inclusive)
    const endSept = addDaysSafe('20/09/2026', 6);
    assert.equal(endSept, '2026-09-26');

    // 27/09/2026 + 6 days = 2026-10-03 (Month boundary transition)
    const endOct = addDaysSafe('27/09/2026', 6);
    assert.equal(endOct, '2026-10-03');

    // Parsing to ISO is normalized and stable
    assert.equal(parseDateToISO('20/09/2026'), '2026-09-20');
    assert.equal(parseDateToISO('27/09/2026'), '2026-09-27');
    assert.equal(parseDateToISO('03/10/2026'), '2026-10-03');
  });

  // =========================================================================
  // AUDIT 8 — Targeted single-permit update without full database upsert
  // =========================================================================
  it('AUDIT 8: updatePermitInSupabase is exported and validates record ID presence', async () => {
    const { updatePermitInSupabase } = await import('../lib/supabase');
    assert.equal(typeof updatePermitInSupabase, 'function', 'updatePermitInSupabase must be an exported function');

    // Attempting to update a record with no ID must fail safely and return false
    const invalidRecord = {
      hospital: 'Hospital A',
      vrm: 'TEST123'
    } as any;
    const result = await updatePermitInSupabase(invalidRecord);
    assert.equal(result, false, 'updatePermitInSupabase must reject records without id/formId');
  });

  // =========================================================================
  // AUDIT 9 — Explicit Data API Table Permissions for anon, authenticated, and service_role
  // Ensures compatibility with upcoming Supabase public schema policy changes
  // =========================================================================
  it('AUDIT 9: master_schema_and_security.sql and supabase_schema.sql include explicit Data API permission grants', () => {
    const masterSql = fs.readFileSync(masterSqlPath, 'utf8');
    const supabaseSql = fs.readFileSync(supabaseSqlPath, 'utf8');

    const tables = ['permits', 'vouchers', 'dispatched_history'];

    for (const table of tables) {
      // 1. Check anon SELECT grant in master_schema_and_security.sql
      assert.match(
        masterSql,
        new RegExp(`GRANT\\s+SELECT\\s+ON\\s+public\\.${table}\\s+TO\\s+anon;`, 'i'),
        `master_schema_and_security.sql must grant SELECT on public.${table} to anon`
      );

      // 2. Check authenticated SELECT, INSERT, UPDATE, DELETE grant in master_schema_and_security.sql
      assert.match(
        masterSql,
        new RegExp(`GRANT\\s+SELECT,\\s*INSERT,\\s*UPDATE,\\s*DELETE\\s+ON\\s+public\\.${table}\\s+TO\\s+authenticated;`, 'i'),
        `master_schema_and_security.sql must grant SELECT, INSERT, UPDATE, DELETE on public.${table} to authenticated`
      );

      // 3. Check service_role SELECT, INSERT, UPDATE, DELETE grant in master_schema_and_security.sql
      assert.match(
        masterSql,
        new RegExp(`GRANT\\s+SELECT,\\s*INSERT,\\s*UPDATE,\\s*DELETE\\s+ON\\s+public\\.${table}\\s+TO\\s+service_role;`, 'i'),
        `master_schema_and_security.sql must grant SELECT, INSERT, UPDATE, DELETE on public.${table} to service_role`
      );

      // 4. Check anon SELECT grant in supabase_schema.sql
      assert.match(
        supabaseSql,
        new RegExp(`GRANT\\s+SELECT\\s+ON\\s+public\\.${table}\\s+TO\\s+anon;`, 'i'),
        `supabase_schema.sql must grant SELECT on public.${table} to anon`
      );

      // 5. Check authenticated SELECT, INSERT, UPDATE, DELETE grant in supabase_schema.sql
      assert.match(
        supabaseSql,
        new RegExp(`GRANT\\s+SELECT,\\s*INSERT,\\s*UPDATE,\\s*DELETE\\s+ON\\s+public\\.${table}\\s+TO\\s+authenticated;`, 'i'),
        `supabase_schema.sql must grant SELECT, INSERT, UPDATE, DELETE on public.${table} to authenticated`
      );

      // 6. Check service_role SELECT, INSERT, UPDATE, DELETE grant in supabase_schema.sql
      assert.match(
        supabaseSql,
        new RegExp(`GRANT\\s+SELECT,\\s*INSERT,\\s*UPDATE,\\s*DELETE\\s+ON\\s+public\\.${table}\\s+TO\\s+service_role;`, 'i'),
        `supabase_schema.sql must grant SELECT, INSERT, UPDATE, DELETE on public.${table} to service_role`
      );
    }
  });

});

