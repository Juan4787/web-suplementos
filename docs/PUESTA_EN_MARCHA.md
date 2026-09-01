# Puesta en marcha y puertas de producción

Esta guía cubre el camino crítico. No autoriza un despliegue por sí sola: cada puerta debe cerrarse con evidencia del proyecto real.

## No-Go vigentes

No publicar para uso comercial mientras ocurra cualquiera de estas condiciones:

- no hay un hosting gratuito cuyos términos permitan este uso comercial, o no se autorizó un plan pago;
- el proyecto Supabase real no está vinculado, migrado y probado;
- la primera dueña no puede iniciar sesión y el rol `staff` no fue comprobado por separado;
- WhatsApp, transferencia, envíos e impuesto conservan valores de ejemplo;
- no se decidió si se migra el Excel histórico y cuál será su fecha de corte;
- no existe una copia reciente de base de datos y del bucket de imágenes fuera de Supabase;
- la prueba manual de pedido completo no está aprobada en celular y escritorio.

La IA no integra esta puerta inicial: el negocio completo tiene que operar sin ella. La infraestructura ya está certificada y activa; Global Zero Data Retention fue comprobado en la organización de Groq asociada a la clave instalada.

## 1. Verificación local previa

Ejecutar en orden y detenerse ante el primer error:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
supabase start
supabase db reset --local --no-seed
supabase test db
supabase db lint --local --level warning
supabase stop
```

`supabase test db` incluye una carrera real entre dos conexiones: con diez unidades físicas y dos pedidos simultáneos de seis, sólo uno puede persistir.

## 2. Crear y migrar Supabase

1. Crear un proyecto Supabase Free dedicado a producción y conservar en un gestor seguro la contraseña de base de datos.
2. Desde este repositorio, iniciar sesión y vincular el proyecto correcto:

   ```bash
   supabase login
   supabase link --project-ref REEMPLAZAR_PROJECT_REF
   supabase migration list
   supabase db push --dry-run
   supabase db push
   supabase migration list
   ```

3. No crear tablas o políticas manualmente en producción. Todo cambio estructural posterior debe ser una nueva migración versionada.
4. En Authentication, desactivar altas públicas y altas anónimas. Sólo deben poder iniciar sesión usuarios creados o invitados por una persona administradora.
5. Confirmar en Storage que existe el bucket público `product-images`, limitado a WebP y 5 MB. Que el bucket sea público sólo habilita lectura; las escrituras siguen protegidas por RLS.

## 3. Habilitar la primera dueña sin abrir una puerta pública

1. En `Authentication > Users`, crear o invitar el correo real de la dueña y completar su contraseña.
2. El trigger crea automáticamente un perfil `staff` inactivo. Esto es intencional: crear un usuario Auth no concede acceso al negocio.
3. Abrir [bootstrap_first_owner.sql](../supabase/manual/bootstrap_first_owner.sql), reemplazar las dos apariciones de `REEMPLAZAR_POR_CORREO_REAL` por el mismo correo y ejecutar el archivo completo en SQL Editor.
4. El bloque se niega a continuar si el correo no coincide con exactamente un usuario o si ya existe otra dueña activa.
5. Iniciar sesión con esa cuenta y comprobar que puede abrir Usuarios, Exportar y Analíticas.
6. Crear una segunda cuenta de prueba como personal. Debe quedar inactiva hasta que la dueña la habilite desde Usuarios; luego no debe obtener costos, ventas, analíticas, exportación ni permisos aunque intente llamar la API manualmente.

Nunca colocar una clave `service_role`, una clave secreta o la contraseña de base de datos en variables `VITE_*`.

## 4. Configuración real obligatoria

Desde Configuración, reemplazar y verificar:

- nombre y slogan;
- número de WhatsApp en formato internacional sólo con dígitos;
- alias y CBU/CVU;
- envío tradicional y express;
- tasa de impuesto realmente acordada.

Luego cargar al menos un producto real con imagen, costo, precio, reglas de reposición y stock inicial auditado.

## 5. Variables del frontend

Configurar únicamente variables públicas:

```text
VITE_APP_MODE=supabase
VITE_SUPABASE_URL=https://PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_AI_ENABLED=true
```

Un build de producción sin Supabase muestra una pantalla de configuración pendiente; nunca cae silenciosamente en la demo.

## 6. Hosting y backend de IA

El hosting elegido es Cloudflare Worker + Static Assets. La fuente de verdad es `wrangler.jsonc` y el destino autorizado es únicamente:

```text
perfil: impulso
cuenta: app de suplementos
Worker: impulso
URL: https://impulso.suplementos.workers.dev
```

Usar Node `24.20.0` y ejecutar en orden:

```bash
nvm use
pnpm worker:deploy:dry
pnpm worker:deploy
```

Ambos scripts validan el perfil, directorio, cuenta y nombre de Worker antes de publicar. Static Assets resuelve el SPA; no volver a crear `public/_redirects`, porque la reescritura de Pages produce un bucle con `not_found_handling: "single-page-application"`.

Los secretos de runtime se sincronizan con `pnpm worker:secrets:sync` y son solamente `GROQ_API_KEY`, `SUPABASE_URL` y `SUPABASE_ANON_KEY`. El valor de ningún secreto debe imprimirse ni guardarse en Git. Nunca instalar `SUPABASE_SERVICE_ROLE_KEY`.

La habilitación inicial se completó el 01/09/2026. Si cambia la clave, proyecto u organización de Groq, volver a cerrar los tres flags y repetir, en este orden:

1. iniciar sesión en la organización de Groq asociada a la clave instalada;
2. activar y comprobar Zero Data Retention en Data Controls;
3. ejecutar de nuevo la certificación real de ambos modelos;
4. cambiar `GROQ_ZDR_CONFIRMED` a `true`;
5. cambiar `AI_ENABLED` y `VITE_AI_ENABLED` a `true`;
6. publicar y repetir el smoke test remoto.

No activar un solo flag ni reemplazar la comprobación de ZDR por la política de retención predeterminada de Groq.

## 7. Prueba de aceptación mínima

Con cuentas reales de dueña y personal:

1. Crear producto y cargar stock.
2. Armar carrito público y comprobar disponibilidad.
3. Generar el mensaje en celular y escritorio; pegarlo en el importador.
4. Confirmar una sola vez y volver a pegar el mismo mensaje: la segunda importación debe rechazarse sin duplicar nada.
5. Marcar pago, preparación y entrega/envío en orden; comprobar reservas, stock y movimientos.
6. Crear y recibir una compra; comprobar stock en camino, costo actual y conservación del costo histórico de la venta.
7. Verificar que personal no vea ni obtenga importes financieros.
8. Exportar Excel, abrirlo y revisar sus 13 hojas.
9. Cerrar sesión y repetir el ingreso en otro dispositivo.

## 8. Operación en Supabase Free

Supabase Free no incluye backups automáticos y puede pausar un proyecto por baja actividad. Revisar los correos de la organización. Si se pausa, la acción correcta es reanudarlo desde el Dashboard; no se agregarán pings artificiales para eludir esa política.

El procedimiento de respaldo y restauración está en [RECUPERACION.md](RECUPERACION.md).
