-- Migración: Fijar tarifas de flete en 0 en la configuración comercial
-- Debido a que los envíos se realizan a distintas partes del país, el costo se coordina
-- directamente con el cliente según destino y no se cobran importes fijos predeterminados en la tienda.

update public.store_settings
set standard_shipping_cents = 0,
    express_shipping_cents = 0
where singleton_id = 1;
