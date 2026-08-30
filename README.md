# Impulso Suplementos

Aplicación React para una tienda única de suplementos: ecommerce público con cierre por WhatsApp y panel privado para pedidos, inventario, compras, ventas, analíticas, exportación XLSX e IA analítica de solo lectura.

El núcleo funcional está terminado y verificado localmente. La IA quedó desacoplada y apagada hasta elegir modelo/proveedor. La salida a producción sigue bloqueada por decisiones y credenciales externas; ver `docs/PUESTA_EN_MARCHA.md`.

## Desarrollo local

Requisitos: Node 20.19 o superior y pnpm 10.

```bash
pnpm install
pnpm dev
```

Sin variables de Supabase, el servidor de desarrollo abre una demo local claramente identificada. Un build de producción sin configuración no sustituye Supabase por datos ficticios: muestra una pantalla de configuración pendiente.

## Verificación

```bash
pnpm check
pnpm test
pnpm build
pnpm audit
```

En esta computadora las verificaciones pesadas se ejecutan de forma secuencial.

## Documentación de continuidad

Antes de continuar trabajo estructural, leer en este orden:

1. [`docs/CONTINUIDAD.md`](docs/CONTINUIDAD.md)
2. [`docs/DECISIONES_DOMINIO.md`](docs/DECISIONES_DOMINIO.md)
3. [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md)
4. [`docs/PLAN_IMPLEMENTACION.md`](docs/PLAN_IMPLEMENTACION.md)
5. [`docs/PUESTA_EN_MARCHA.md`](docs/PUESTA_EN_MARCHA.md)
6. [`docs/RECUPERACION.md`](docs/RECUPERACION.md)
7. El contrato específico de la función que se vaya a modificar.

No hay despliegue ni proyecto Supabase real vinculados a este repositorio todavía. Las migraciones y funciones se versionan en `supabase/`.
