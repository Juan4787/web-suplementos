-- Only the complete, owner-checked shortage operations may invoke this helper.
-- It must remain callable inside replace_purchase_shortage: that transaction
-- records the shortage before moving its reservations to the replacement.
-- Blocking reservations in the helper itself would break that valid operation.
revoke all on function public.declare_item_shortage(uuid, integer, text)
  from public, anon, authenticated;
