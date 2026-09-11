# Contrato de pedido por WhatsApp v2 (Texto Plano)

El mensaje es un protocolo determinístico, limpio y legible. Para evitar pérdidas de formato en portapapeles de dispositivos móviles que limpian las negritas (`* *`), el protocolo se genera **en texto plano sin asteriscos**, garantizando máxima fidelidad de copiado y pegado.

El parser del importador es **dual y retrocompatible**: acepta tanto mensajes nuevos sin asteriscos como mensajes legados con negrita (`*PEDIDO DE TIENDA DE SUPLEMENTOS*`, `*PEDIDO IMPULSO*`, etc.), o mensajes legados cuyos asteriscos fueron eliminados al copiar.

```text
PEDIDO DE TIENDA DE SUPLEMENTOS

Código de pedido
<UUID v4 único>

Nombre
Juan Pérez

Productos
- [CREA300] Creatina Monohidratada | 300 g | 2 x $ 25.000 = $ 50.000

Subtotal
$ 50.000

Medio de pago
Transferencia

Entrega
Envío a domicilio

Tipo de envío
Express

Envío
$ 4.500

Dirección
Av. Siempre Viva

Altura
742

Teléfono
11 5555 5555

Total
$ 54.500

Código de control
<huella FNV-1a>
```

Reglas:

- orden de secciones fijo;
- un UUID v4 por checkout permite que el backend rechace la reimportación accidental del mismo mensaje;
- etiquetas y encabezados en texto plano limpio (sin asteriscos de negrita `* *`);
- importes enteros en centavos internamente, formateados en ARS;
- la huella corta (FNV-1a) detecta alteraciones accidentales al copiar o pegar, pero no es una firma de seguridad y el backend no confía ciegamente en ella;
- el backend vuelve a validar producto, precio y stock de catálogo al confirmar;
- un mensaje válido nunca escribe directamente: primero muestra revisión editable en `/app/importar`.
