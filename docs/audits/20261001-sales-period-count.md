# Ventas: períodos completos y conteo de cobros

## Alcance y criterio

- Los intervalos incluyen todas las fechas entre Desde y Hasta, en Buenos Aires.
- `orders` y `series.orderCount` cuentan pedidos con pago `paid`, incluidas las ventas al costo. Los regalos se informan aparte.
- El ticket promedio usa facturación cobrada / pedidos cobrados, con redondeo final a centavos.
- Se conserva el contrato JSON, la autorización y los snapshots históricos.
- La migración cambia dos funciones de lectura (informe y margen por producto del asistente). No modifica clientes, pedidos, compras, reservas, stock ni gastos.
- Los datos sintéticos se prueban solo en la base local aislada, dentro de una transacción revertida.

## Diagnóstico confirmado antes de corregir

La definición remota coincide con `20260915120000_misc_expenses.sql`. Para 1/5/2026–1/10/2026 aplica `comparisonCutoffDay=1`, excluye los 110 registros de septiembre y sus tres gastos. Devuelve ARS 264.400, costo 176.700 y neto 87.700. La suma independiente del intervalo completo devuelve ARS 8.685.650, costo 5.764.012, gastos 163.173 y neto 2.758.465. Hay 105 pedidos cobrados (96 normales + 9 al costo) y 10 regalos. Es una foto de la base del diagnóstico, no un total permanente.

El contador de producción excluye ventas al costo, aunque sus importes integran la facturación. El demo las cuenta. La serie también necesita usar el mismo criterio; el ticket promedio debe ajustar conjuntamente numerador y denominador.

## Registro de avance

1. Revisión de consumidores: pantalla, API real, demo, serie mensual, gastos, resumen y comparación del asistente, exportación. Sin ediciones en flujos de escritura del negocio.
2. Reproducción previa: demo 7/8 pruebas fallan; PostgreSQL 6/14 controles fallan. El fixture comprueba 5.120 intervalos sobre los 731 días de 2031 y 2032, con cobros normales/al costo, regalos sin `paid_at`, pendientes, reembolsados y tres recurrencias de gastos. Todo terminó en ROLLBACK.
3. Corrección y auditoría de calendario, cálculos y permisos en aislamiento local completadas.
4. Aplicación remota, conciliación protegida y publicación completadas. La comprobación de uso y sus límites se detallan al final.

Cada resultado posterior se agregará con su entorno y sus límites. No se considera que una prueba de UI o de demo pruebe la consulta real.

### Hallazgos adyacentes reproducidos

- `topProducts` reconstruía el costo multiplicando el snapshot unitario, aunque la línea tiene un costo total exacto que combina lotes físicos/entrantes. El fixture con costo total diferente demuestra la pérdida de precisión. Se corrige su lectura en el informe y en la consulta por producto del asistente; esta segunda consulta falló con el fixture antes de corregirla.
- El demo omitía regalos sin fecha de pago y agrupaba meses por UTC. Se alinea su lectura con la fecha efectiva local de producción.
- «Últimos 30 días» restaba 30 días y luego incluía ambos extremos: eran 31. Se resta 29 y se prueba la solicitud real de ambas consultas alrededor de febrero, fin de mes y cambio de año.
- Cuatro reproducciones nuevas de UI fallaron antes de corregirlas: dispositivo en otro huso horario, volver a la pestaña al día siguiente, borrar una fecha personalizada y período de solo regalos. Se usa la fecha canónica de Buenos Aires, se actualizan presets al recuperar foco (el personalizado se preserva), se evita consultar fechas incompletas/invertidas y no se presenta un porcentaje indefinido como 0%.

### Evidencia local completada

- PostgreSQL: 24 controles aprobados; incluyen 5.120 intervalos, 731 días de dos años consecutivos, gastos puntuales/semanales/mensuales, medianoche local, solo al costo, solo regalos, cobro de importe cero y redondeo de medio centavo. Candidata aplicada dentro de la transacción de fixtures, revertida con ROLLBACK.
- Regresión de gastos: 43/43 controles aprobados con la candidata, también revertidos.
- Suite general antes de los últimos cuatro ajustes de UI: 62 archivos, 484 pruebas aprobadas. Se excluyó expresamente el archivo de debug ajeno no versionado. Queda la reauditoría de esos ajustes y el build.
- Dry run remoto por pooler: exactamente una migración pendiente, sin seeds ni roles. El transporte directo falló antes de ejecutar cambios y se usó el pooler validado.

- Calendario histórico: se descubrió una suposición incorrecta UTC−3 fija en el demo, reproducida con dos ventas en los extremos del día durante horario de verano de 2008. Se usa la zona IANA de Buenos Aires, igual que PostgreSQL. El test inicial de 2000–2100 también suponía UTC−3 en años con horario de verano: se corrigió su oráculo, no la zona de negocio. Incluye transiciones explícitas, bisiestos de 2000 y no bisiesto de 2100.
- Reauditoría focalizada de UI, demo y calendario: 47/47 controles pasaron antes de los dos controles adicionales de retorno móvil y margen con impuestos.

### Revisión adicional de presentación y consumo

- Suite general: 63 archivos / 505 pruebas aprobadas antes de los tres últimos controles de tablas. Los ajustes posteriores están limitados a esta pantalla y al agregado de lectura del demo; se reauditan los consumidores afectados.
- Se reprodujeron dos fallos de tabla: 0,0% indefinido para productos sin facturación y claves duplicadas para snapshots de nombres anteriores del mismo producto. Se muestra un guion y se conserva una identidad por producto/nombre.
- Se reprodujo una fecha de cobro de 30/9 en Buenos Aires mostrada como 1/10 en un dispositivo UTC. La fecha visible ahora utiliza la misma zona que el filtro; los regalos sin fecha de pago usan la fecha histórica de alta, igual que la consulta.
- Se aclara que la lista incluye cobros y regalos, y que los regalos no integran el conteo de cobros. Los rankings conservan el límite de diez de producción; la copia explica que los totales incluyen todos los productos. El demo tenía 19 filas en un fixture de 20 ventas y fusionaba dos nombres históricos: se alinea esa lectura con producción sin recortar los totales.
- Preflight real, solo lectura: 0 costos de línea faltantes; 0 diferencias entre el costo de pedido y la suma de sus líneas; 0 regalos con importe distinto de cero; 0 ventas al costo no neutrales. Existe 1 snapshot de línea diferente de costo unitario × cantidad. Se guardó la definición previa para reversión de funciones.
- Fingerprint previo remoto: 21 tablas públicas, 82 funciones públicas/privadas y definiciones de triggers, sin contenidos personales en el registro.

### Puertas finales de frontend

- Reauditoría final de consumidores: 73/73 pruebas, en UTC y en Pacific/Auckland (DST y día de dispositivo distinto), después de los ajustes de tabla/ranking.
- El tipado del build detectó `taxAmountCents` nullable en el demo y cuatro opciones `exact` no admitidas por ByRoleOptions en los nuevos tests. Se reprodujo además el impuesto nulo con el fixture: fallaba antes del fallback; se corrigió a la misma ausencia=0 utilizada por el agregado del demo y se reauditaron los 73 controles. Las opciones del test se eliminaron sin alterar su selección por nombre exacto.

### Aplicación y verificación real de base de datos

- Migración `20261001120000_sales_analytics_full_period.sql` aplicada al proyecto verificado, sin seeds ni roles adicionales.
- Comparación remota antes/después: las 21 tablas públicas conservan las mismas huellas y conteos. Permisos, propietarios, configuración, 80 funciones no afectadas y triggers quedaron iguales. Cambiaron exactamente los cuerpos de `get_sales_analytics` y `ai_get_product_performance`.
- Conciliación independiente protegida con READ ONLY desde conexión y transacción: 2.016 rangos reales, 0 discrepancias. Incluye todos los días de 2026 en cinco familias de período y las combinaciones de fronteras registradas en los datos, meses vacíos, puntos mensuales individuales, conteos/costos/impuestos/gastos, promedio exacto con BigInt, márgenes históricos por producto, listing y facts del asistente. Cerró con ROLLBACK. No es una prueba de todas las combinaciones de fechas posibles ni de futuros registros desconocidos.
- Foto real 1/5/2026–1/10/2026: facturación ARS 8.685.650; mercadería 5.764.012; gastos 163.173; neto 2.758.465; 105 cobros, incluidos 9 al costo; 10 regalos aparte; ticket ARS 82.720,48.
- Build de producción y dry run Cloudflare aprobados; TypeScript sin errores. Se guardaron hashes del HTML, índice y chunks de Ventas/demo/calendario para comparar lo servido después de publicar.

### Prueba de uso real y caché de producción

- El navegador recibió los hashes publicados y consultó exclusivamente los RPC de lectura permitidos; las mutaciones quedaron bloqueadas por interceptación preventiva. Los importes visibles coinciden con las respuestas verificadas. Mes anterior devolvió 100 cobros (92 normales + 8 al costo).
- Durante la prueba se registró un nuevo pago en producción: una consulta READ ONLY confirmó 1 pago posterior al baseline, 106 cobros y facturación 874.365.000 centavos, con neto 278.846.500. Los totales antiguos del diagnóstico son snapshots y no se deben tratar como permanentes. No se creó ese pago mediante los fixtures ni el navegador auditado.
- Se reprodujo un hueco de entorno: el QueryClient de pruebas usaba gcTime=0 y staleTime=0, mientras producción conserva períodos 30 segundos. Con la configuración real, volver a un período conocido mantenía el conteo anterior y no pedía el pago nuevo. Se corrige solo en las dos consultas de Ventas (staleTime=0 y refresh siempre al recuperar foco), con un estado visible de actualización antes de los totales.
- Reauditoría de ese cambio: 28/28 pruebas de pantalla, incluyendo caché real conservada, respuesta tardía, borrar una fecha mientras se actualiza y regresar de otra pestaña. El campo queda vacío, la consulta inválida queda deshabilitada y la respuesta vieja no vuelve a mostrar totales.
- Se reprodujo otra inconsistencia de interacción: abrir Evolución cambiaba automáticamente Este mes a Últimos 6 meses. Se conserva ahora el período elegido al cambiar de sección; el usuario puede elegir los seis meses en el selector. Se añade el año a los meses del gráfico y se habla de regalos registrados, sin afirmar que ya se entregaron.
- Dos intentos de republicar textos fueron frenados antes de cambios por la verificación Cloudflare (timeout y respuesta API 502). Se mantuvo la verificación; el reintento posterior tuvo éxito. El cierre de publicación y móvil se registra a continuación.

### Cierre de uso y publicación

- Escritorio de producción (1440 px): al abrir Evolución se conserva Este mes. Se comprobó Últimos 6 meses → Mes anterior → Últimos 6 meses con nuevas solicitudes reales, importes visibles iguales a las respuestas y seis etiquetas mensuales con año. El ranking tiene diez filas; su orden por nombre funciona. Pasar a página 2 y elegir Este mes reinicia la lista. Sin desborde horizontal de la página, errores de ejecución, respuestas HTTP de error ni intentos de mutación.
- Los totales continuaron cambiando por actividad ajena a esta auditoría: la foto posterior del navegador registra 107 cobros y ARS 8.827.650 en seis meses, y 7 cobros / ARS 406.400 en octubre. Se comparó cada pantalla con su respuesta contemporánea, sin restaurar snapshots antiguos ni modificar pagos.
- Móvil Chromium con emulación táctil (390 y 320 px): selector completo dentro de pantalla, gráfico visible, tabla ancha desplazable hasta su última columna, calendario dentro del viewport. Borrar Desde, cambiar de pestaña y regresar conserva el campo vacío, oculta totales anteriores y no solicita un rango inválido. Un rango invertido explica el problema; seleccionar las fechas en el calendario vuelve a habilitar la consulta y sus tres importes coinciden con la respuesta.
- La inspección de capturas encontró un defecto adicional que no detectaba el ancho global: a 320 px, los dos botones de fecha medían 129 px y sus controles sobresalían 17,8125 px, invadiendo el espacio vecino. Se corrigió únicamente la distribución de fechas personalizadas en esta pantalla: una columna en móvil y fila desde `sm`. No se cambió el DatePicker compartido ni ninguna regla de consulta.
- Reauditoría tras ese último cambio: 29/29 pruebas de pantalla; TypeScript y build de producción aprobados. Navegador sobre la nueva publicación en 320, 390, 640 y 1440 px: las fechas y sus controles quedan dentro de cada botón, sin superposición ni desborde de página. Se repitieron borrado, retorno de foco, rango invertido y selección de fechas en calendario móvil y escritorio. El vacío se conserva y los valores válidos coinciden con las respuestas reales. Captura final inspeccionada visualmente.
- Versión final Cloudflare: `a1eb5e04-fe04-4a60-898a-fec553b0b073`. HTML y los cuatro bundles de índice/Ventas/demo/calendario servidos se compararon por SHA-256 con el build local: coincidencia exacta. Índice `index-CdJ1o6M2.js`; Ventas `SalesPage-BzPXadTU.js`.
- Recibos locales agregados, sin credenciales: `output/audit/sales-browser-desktop.txt`, `sales-browser-mobile.txt`, `sales-browser-final-date-layout.txt`, `sales-built-assets-final.json`, `sales-production-readonly.json` y huellas de migración antes/después. Las capturas están en `output/playwright/`; los archivos de evidencia permanecen fuera de Git.
- Alcance de la evidencia: consultas reales de producción y navegador Chromium de escritorio/móvil emulado; no se ejecutó una prueba en un teléfono físico. La suite general de 505 pruebas precedió los últimos ajustes, y las verificaciones posteriores se concentraron en los consumidores afectados (73 controles en dos husos y 29 de pantalla después del último cambio). Los 5.120 intervalos locales y 2.016 remotos verifican esas muestras y sus invariantes; no representan todas las combinaciones futuras ni una garantía de ausencia de cualquier defecto en toda la aplicación.
