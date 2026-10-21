# How to Use This App with Free Supabase

Supabase provides a free cloud PostgreSQL database that syncs your parking permits, voucher codes, and dispatched email logs across devices and team members in real-time.

---

## Step 1: Create a Free Supabase Account & Project

1. Visit [supabase.com](https://supabase.com) and click **Start your project**.
2. Sign in with GitHub or email.
3. Click **New Project**, select a name (e.g. `barts-parking-concessions`), set a database password, and choose your preferred region.
4. Select the **Free Tier** ($0/month) and click **Create new project**.

---

## Step 2: Set Up Database Tables & Security Policies

1. In your Supabase Dashboard left menu, click **SQL Editor**.
2. Click **New query**.
3. Copy and paste the entire contents of `master_schema_and_security.sql` (found in the root directory of this repository).
4. Click **Run** (or press `Ctrl + Enter`).
5. You will see "Success. No rows returned" confirming that:
   - `permits`, `vouchers`, and `dispatched_history` tables are created with RLS enabled.
   - Explicit Data API table grants are applied to `anon`, `authenticated`, and `service_role` to ensure PostgREST and supabase-js access.
   - Explicit `authenticated` policies are applied, with write access blocked for `anon`.
   - The `log_dispatch` RPC function is secured with `SECURITY DEFINER` and restricted to `service_role`.
   - The `tr_auto_enable_rls` event trigger is active to automatically enforce RLS and Data API permissions on any future tables.

---

## Step 3: Get Your Credentials

1. In your Supabase Dashboard left menu, click **Project Settings** (gear icon) -> **API**.
2. Copy the following values:
   - **Project URL** (e.g., `https://xyzcompany.supabase.co`)
   - **anon / public key** (long string starting with `eyJ...`)

---

## Step 4: Configure Environment Variables

Add your Supabase credentials to your `.env` file (or set them in AI Studio / Deployment settings):

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## Step 5: Row Level Security (RLS) Configuration (Option A: Anon Client)

If your app uses the standard anonymous client without individual user authentication, ensure public write (INSERT/UPDATE) access is enabled for the tables.

Run the following SQL snippet in the **Supabase SQL Editor**:

```sql
-- Allow public write access on dispatched_history
DROP POLICY IF EXISTS "Allow authenticated modifications on dispatched_history" ON public.dispatched_history;
DROP POLICY IF EXISTS "Allow public insert and update on dispatched_history" ON public.dispatched_history;
DROP POLICY IF EXISTS "Allow public all on dispatched_history" ON public.dispatched_history;

CREATE POLICY "Allow public insert and update on dispatched_history"
ON public.dispatched_history
FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- Allow public write access on permits
DROP POLICY IF EXISTS "Allow authenticated modifications on permits" ON public.permits;
DROP POLICY IF EXISTS "Allow public insert and update on permits" ON public.permits;
DROP POLICY IF EXISTS "Allow public all on permits" ON public.permits;

CREATE POLICY "Allow public insert and update on permits"
ON public.permits
FOR ALL
TO public
USING (true)
WITH CHECK (true);

-- Allow public write access on vouchers
DROP POLICY IF EXISTS "Allow authenticated modifications on vouchers" ON public.vouchers;
DROP POLICY IF EXISTS "Allow public insert and update on vouchers" ON public.vouchers;
DROP POLICY IF EXISTS "Allow public all on vouchers" ON public.vouchers;

CREATE POLICY "Allow public insert and update on vouchers"
ON public.vouchers
FOR ALL
TO public
USING (true)
WITH CHECK (true);
```

---

## Step 6: Start Using Supabase Sync

Once `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are defined:
- The app automatically connects to Supabase on launch.
- A **Supabase Connected** badge will appear in the top header.
- Permits, voucher database records, and dispatched email statuses will automatically sync to your cloud database in real-time!
- If credentials are ever missing, the app gracefully falls back to local browser storage (`localStorage`) so you never lose work.
