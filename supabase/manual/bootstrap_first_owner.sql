-- EJECUCIÓN MANUAL, UNA SOLA VEZ, DESPUÉS DE CREAR EL USUARIO EN AUTH.
-- Este archivo habilita el rol de dueña inicial (owner) para la cuenta principal.

do $bootstrap_first_owner$
declare
  v_owner_email text := lower(btrim('juanpabloaltamira@protonmail.com'));
  v_matches integer;
  v_existing_owners integer;
begin
  if v_owner_email = '' or upper(v_owner_email) like '%REEMPLAZAR%' then
    raise exception 'Reemplazá REEMPLAZAR_POR_CORREO_REAL antes de ejecutar este bloque.';
  end if;

  select count(*) into v_matches
  from public.store_users
  where lower(email_snapshot) = v_owner_email;

  if v_matches <> 1 then
    raise exception 'Se esperaba exactamente un usuario Auth con ese correo; se encontraron %.', v_matches;
  end if;

  if exists (
    select 1
    from public.store_users
    where lower(email_snapshot) = v_owner_email
      and role = 'owner'
      and active
  ) then
    raise notice 'La dueña inicial ya estaba habilitada; no se modificó nada.';
    return;
  end if;

  select count(*) into v_existing_owners
  from public.store_users
  where role = 'owner' and active;

  if v_existing_owners <> 0 then
    raise exception 'La tienda ya tiene una dueña activa. Administrá accesos desde la aplicación.';
  end if;

  update public.store_users
  set role = 'owner', active = true
  where lower(email_snapshot) = v_owner_email;

  raise notice 'Dueña inicial habilitada para %.', v_owner_email;
end;
$bootstrap_first_owner$;

select
  email_snapshot as correo,
  display_name as nombre,
  role as rol,
  active as habilitada
from public.store_users
where lower(email_snapshot) = lower(btrim('juanpabloaltamira@protonmail.com'));
