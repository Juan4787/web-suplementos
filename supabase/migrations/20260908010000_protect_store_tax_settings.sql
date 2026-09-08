-- Only an active owner can read commercial tax configuration.
create or replace function private.store_settings_payload()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'storeName', store_name, 'tagline', tagline, 'whatsappPhone', whatsapp_phone,
    'transferAlias', transfer_alias, 'transferAccount', transfer_account,
    'standardShippingCents', standard_shipping_cents,
    'expressShippingCents', express_shipping_cents,
    'taxRateBasisPoints', case when private.is_owner() then tax_rate_basis_points else null end,
    'currency', currency
  ) from public.store_settings where singleton_id=1;
$$;
