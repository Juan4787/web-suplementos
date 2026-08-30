# Fuente de verdad para continuar el proyecto

Este archivo existe para que una compactación de contexto no convierta decisiones firmes en suposiciones.

## Norte del producto

- Cliente: ver productos, armar el pedido y continuarlo por WhatsApp.
- Recepción: pegar el mensaje generado, revisar y confirmar el pedido.
- Operación: preparar, cobrar, enviar o entregar con una siguiente acción evidente.
- Dueña: entender stock, compras, ventas y margen; exportar sus datos; consultar una IA read-only.
- La lógica exacta vive en PostgreSQL. React nunca debe coordinar una media transacción.
- El núcleo sigue funcionando cuando la IA o su proveedor no responden.
- No se introduce deliberadamente ningún costo recurrente.

## Decisiones firmes

- React 19 + Vite + TypeScript + TanStack Router + TanStack Query + Tailwind.
- Supabase para PostgreSQL, Auth, RLS, Storage y Edge Functions.
- La IA se integra detrás de `business-ai` mediante un adaptador propio. El proveedor, el modelo principal y cualquier fallback están **pendientes de decisión**.
- IA exclusivamente para lectura e interpretación; las cifras se calculan en PostgreSQL.
- XLSX se construye en un Web Worker y la librería se carga solo al exportar.
- WhatsApp usa `wa.me` en móvil y `web.whatsapp.com/send` en escritorio.
- Un pedido público no reserva stock. La reserva ocurre al confirmar su importación.
- No se borra un producto con historia: se archiva.
- No se estima IPC faltante.
- Los errores visibles explican el problema y el siguiente paso sin mostrar códigos internos.

## Alertas externas vigentes al 28/08/2026

- Vercel Hobby prohíbe uso comercial. El proyecto conserva un build Vite portable y configuración técnica de Vercel, pero Vercel Hobby es **No-Go para producción**. Vercel Pro rompe el objetivo de costo recurrente cero. La decisión de hosting comercial gratuito debe cerrarse antes de publicar.
- Supabase Free puede pausar proyectos con muy poca actividad durante siete días. La interfaz debe explicar cómo reanudarlo; no se crearán pings artificiales para evadir esa política.
- Supabase Free no incluye transformación de imágenes. El navegador dimensiona y convierte cada archivo a WebP antes de subir; Storage guarda el archivo ya optimizado.
- Se investigó Groq como candidato, pero no se lo considera elegido. Antes de implementar el adaptador final hay que volver a verificar modelos estables, límites, retención y condiciones comerciales vigentes del proveedor seleccionado.
- Sea cual sea el proveedor, la función debe limitar solicitudes, iteraciones, herramientas y tamaño de respuesta, y debe exponer una degradación segura sin afectar el núcleo.

## Estado de implementación

La lista autoritativa está en `PLAN_IMPLEMENTACION.md`. No marcar una fase terminada por la mera existencia de archivos: exige sus verificaciones.

Al cierre local del 28/08/2026, el núcleo está implementado y verificado: tienda, checkout/WhatsApp, importación idempotente, roles, transacciones de stock/pedidos/compras, analíticas e IPC, respaldo XLSX y recuperación. La migración se reconstruyó desde cero, el lint SQL quedó limpio y las 43 pruebas de base —incluida concurrencia— aprobaron. TypeScript, 14 pruebas web, build y auditoría de dependencias también aprobaron.

La IA permanece deliberadamente apagada. Existe únicamente el contrato neutral, la ruta protegida y `VITE_AI_ENABLED=false`; no hay proveedor, modelo, secreto ni Edge Function activos.

No existe todavía evidencia remota. Los siguientes pasos autorizables son, en este orden:

1. decidir un hosting gratuito que permita uso comercial, o autorizar uno pago;
2. crear/vincular el proyecto Supabase y aplicar la migración;
3. crear la primera dueña con el bootstrap manual y validar una cuenta de personal;
4. cargar configuración, productos e imágenes reales;
5. decidir migración histórica/fecha de corte y si la hoja `PENDIENTES` entra al alcance;
6. ejecutar la matriz de aceptación remota y el simulacro de recuperación;
7. recién al final, elegir proveedor/modelo de IA y completar su fase.

## Punto de reanudación

Si una sesión se interrumpe:

1. revisar `git status --short` sin descartar cambios;
2. leer la última sección de este archivo y el plan;
3. ejecutar primero la prueba focalizada del área modificada;
4. ejecutar `pnpm check`, pruebas de a una y build;
5. separar siempre evidencia local, Supabase, GitHub y hosting.
