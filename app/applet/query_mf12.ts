import { getSupabaseClient } from './src/lib/supabase';

async function main() {
  const client = getSupabaseClient();
  if (!client) {
    console.log('Supabase client not configured.');
    return;
  }

  const { data, error } = await client
    .from('permits')
    .select('id, vrm, date_required, date_expiry, voucher_code, cancellation_reason, driver_name')
    .ilike('vrm', '%MF12YCO%')
    .order('id');

  if (error) {
    console.error('Error querying permits:', error);
  } else {
    console.log('QUERY RESULTS FOR MF12YCO:');
    console.table(data);
  }
}

main();
