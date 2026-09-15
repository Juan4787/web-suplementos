-- Migration: increase_product_description_limit
-- Description: Eleva el límite de caracteres de la descripción de productos de 2.000 a 10.000 caracteres.

alter table public.products drop constraint if exists products_description_check;
alter table public.products add constraint products_description_check check (char_length(description) <= 10000);
