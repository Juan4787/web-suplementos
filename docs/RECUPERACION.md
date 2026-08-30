# Respaldo y recuperación

Hay tres capas distintas. Ninguna reemplaza a las demás.

## 1. Exportación XLSX para los datos del negocio

La dueña usa **Exportar todos mis datos** al final de cada jornada con movimientos importantes y conserva copias fuera de Supabase.

El contrato `impulso-business-backup/v1` contiene 13 hojas: resumen/configuración, productos, stock, pedidos, detalle de pedidos, ventas, compras, detalle de compras, movimientos, reservas, clientes, IPC y usuarios. Incluye IDs, snapshots, permisos y referencias; no contiene fórmulas ni macros.

No incluye contraseñas, archivos binarios de imágenes, secretos, código ni esquema SQL. Por eso sirve como respaldo comercial legible y materia prima de reconstrucción, pero no restaura por sí solo una instancia Supabase.

Control mínimo de cada archivo:

- el nombre contiene fecha y hora;
- abre sin reparación en Excel o LibreOffice;
- muestra 13 hojas;
- los conteos del Resumen son coherentes;
- se copia a un medio independiente del proyecto.

## 2. Copia lógica de PostgreSQL

Supabase recomienda que los proyectos Free exporten regularmente su base. Una persona técnica debe obtener el `Session pooler connection string` desde **Connect** y ejecutar, en una carpeta fechada fuera del repositorio:

```bash
supabase db dump --db-url "CONNECTION_STRING" -f roles.sql --role-only
supabase db dump --db-url "CONNECTION_STRING" -f schema.sql
supabase db dump --db-url "CONNECTION_STRING" -f data.sql --use-copy --data-only -x "storage.buckets_vectors" -x "storage.vector_indexes"
```

La conexión contiene una contraseña: no pegarla en tickets, commits, capturas ni historial compartido. La copia debe cifrarse si sale del equipo autorizado.

Frecuencia mínima sugerida para esta tienda:

- XLSX después de una jornada con operaciones;
- dump lógico semanal y antes de cada migración;
- ensayo de restauración antes del Go-Live y después de cambios estructurales importantes.

## 3. Copia de imágenes

Una copia de base sólo conserva metadatos de Storage, no los objetos. Descargar por separado el bucket:

```bash
supabase login
supabase link --project-ref REEMPLAZAR_PROJECT_REF
supabase storage cp ss://product-images ./product-images -r --experimental --linked
```

Guardar la carpeta junto al dump lógico, con la misma fecha de corte.

## Ensayo de restauración

No ensayar sobre producción. Crear un proyecto Supabase vacío temporal y seguir la guía oficial de backup/restore:

1. restaurar roles, esquema y datos con `psql --single-transaction --variable ON_ERROR_STOP=1`;
2. volver a subir el bucket `product-images`;
3. comprobar migraciones, Auth, Storage y configuración;
4. iniciar sesión con una cuenta controlada;
5. comparar conteos con el XLSX del mismo corte;
6. recorrer pedido, stock, compra y exportación.

Una copia no se considera verificada hasta que este ensayo termina y queda registrada su fecha.

## Incidentes

- Proyecto Free pausado: reanudar desde Supabase Dashboard y verificar el flujo completo.
- Frontend caído con Supabase sano: publicar el mismo commit/configuración en un hosting comercialmente válido; no tocar los datos.
- Imagen faltante: recuperar el objeto del bucket y conservar exactamente su ruta `catalog/<uuid>.webp`.
- Corrupción lógica o borrado: detener nuevas operaciones, conservar evidencias y restaurar en un proyecto nuevo desde el último corte consistente. No sobrescribir producción durante el diagnóstico.
