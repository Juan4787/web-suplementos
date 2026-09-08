# Impulso Suplementos

Aplicación React para una tienda única de suplementos: ecommerce público con cierre por WhatsApp y panel privado para pedidos, inventario, compras, ventas, analíticas, exportación XLSX e IA analítica de solo lectura.

La aplicación usa Supabase y está publicada en Cloudflare Worker. El estado de entrega, las correcciones verificadas y los pendientes están en [`docs/AUDITORIA_FINAL_2026-09-08.md`](docs/AUDITORIA_FINAL_2026-09-08.md). El stock real está pendiente de carga; las operaciones anteriores eran ficticias y fueron retiradas con respaldo.

## Desarrollo local

Requisitos: Node 20.19 o superior y pnpm 10.

```bash
pnpm install
pnpm dev
```

El modo predeterminado conecta con la tienda de Supabase. Para trabajar con datos de demostración sin escribir en la tienda real, iniciá explícitamente `VITE_APP_MODE=demo pnpm dev`. Las credenciales privadas pertenecen a `.env.local`, que está excluido de Git.

## Verificación

```bash
pnpm check
pnpm test
pnpm build
pnpm audit
```

En esta computadora las verificaciones pesadas se ejecutan de forma secuencial, con un solo worker. Las pruebas SQL se ejecutan con `pnpm exec supabase test db --local`, usando la instancia local existente. El recorrido E2E que escribe en Supabase remoto exige habilitación explícita; no forma parte de la verificación cotidiana.

## Documentación de continuidad

Antes de continuar trabajo estructural, leer en este orden:

1. [`docs/CONTINUIDAD.md`](docs/CONTINUIDAD.md)
2. [`docs/DECISIONES_DOMINIO.md`](docs/DECISIONES_DOMINIO.md)
3. [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md)
4. [`docs/PLAN_IMPLEMENTACION.md`](docs/PLAN_IMPLEMENTACION.md)
5. [`docs/PUESTA_EN_MARCHA.md`](docs/PUESTA_EN_MARCHA.md)
6. [`docs/RECUPERACION.md`](docs/RECUPERACION.md)
7. El contrato específico de la función que se vaya a modificar.

El destino es el Worker `tienda` y el proyecto Supabase `web-suplementos`. Los scripts de publicación y migración validan ese destino. Las migraciones y funciones se versionan en `supabase/`; una validación local no demuestra que el frontend nuevo esté publicado.
