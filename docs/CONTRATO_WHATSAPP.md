# Contrato de pedido por WhatsApp v1

El mensaje es un protocolo determinístico y legible. El parser solo acepta mensajes con encabezado y versión generados por la tienda.

```text
*PEDIDO IMPULSO · V1*

*Código de pedido*
<UUID v4 único>

*Nombre*
Juan Pérez

*Productos*
- [CREA300] Creatina Monohidratada | 300 g | 2 x $ 25.000 = $ 50.000

*Subtotal*
$ 50.000

*Medio de pago*
Transferencia

*Entrega*
Envío a domicilio

*Tipo de envío*
Express

*Envío*
$ 4.500

*Dirección*
Av. Siempre Viva

*Altura*
742

*Teléfono*
11 5555 5555

*Total*
$ 54.500

*Código de control*
<huella corta>
```

Reglas:

- orden de secciones fijo;
- un UUID v4 por checkout permite que el backend rechace la reimportación accidental del mismo mensaje;
- etiquetas en negrita de WhatsApp y valores sin formato;
- importes enteros en centavos internamente, formateados en ARS;
- la huella corta detecta alteraciones accidentales, pero no es una firma de seguridad y el backend no confía en ella;
- el backend vuelve a validar producto, precio y stock al confirmar;
- un mensaje válido nunca escribe directamente: primero muestra revisión editable.
