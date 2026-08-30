# Arquitectura

## Capas

```text
React/Vite
  ├─ tienda pública + carrito local
  ├─ panel autenticado
  ├─ TanStack Query (caché y mutaciones)
  └─ módulos lazy: analíticas, IA y XLSX
          │
          ▼
Supabase
  ├─ Auth + perfiles/roles
  ├─ PostgreSQL + RLS
  ├─ RPC transaccionales
  ├─ Storage de imágenes preoptimizadas
  └─ Edge Function business-ai (pendiente y desactivada)
          │
          ▼
Adaptador de IA (decisión postergada)
  ├─ proveedor y modelo configurables
  ├─ fallback opcional configurable
  └─ tool calling local sobre RPC read-only
```

## Fronteras

- El navegador puede pedir operaciones de negocio, pero no encadena escrituras críticas.
- Los RPC validan rol, estado previo, stock y snapshots dentro de una transacción.
- Las herramientas de IA son una lista cerrada. No aceptan SQL ni nombres de tabla.
- Los errores internos se registran con contexto mínimo y se traducen a un contrato seguro para UI.
- Los datos financieros se almacenan y consultan separados de las superficies operativas.

## Rendimiento

- Cada ruta privada se importa de forma diferida.
- Listados crecientes usan paginación en servidor.
- Dashboard y analíticas consultan agregados de PostgreSQL.
- No se activa Realtime global.
- Imágenes: dimensionado y compresión WebP en cliente antes de Storage; `loading=lazy` fuera del primer viewport.
- XLSX: dataset autorizado, revisión inicial/final, Web Worker y dependencia lazy.
- IA, al final: mensajes acotados, resultados agregados compactos y límite estricto de rondas. El número exacto se fijará con el proveedor elegido.

## Adaptadores

El frontend habla con un contrato `BusinessApi`. Hay dos implementaciones:

- Supabase para entornos conectados.
- Demo local, solo en desarrollo o con `VITE_APP_MODE=demo`, siempre identificada visualmente.

Producción nunca cae silenciosamente a demo por falta de variables.
