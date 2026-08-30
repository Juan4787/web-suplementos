# Guía de Despliegue en Cloudflare Pages

Esta guía detalla los pasos para desplegar **Impulso Suplementos** en **Cloudflare Pages** con soporte completo para enrutamiento SPA (Single Page Application), cabeceras de seguridad HTTP, almacenamiento en caché perimetral (Edge CDN) y variables de entorno.

---

## 1. Archivos de Configuración Incluidos

El proyecto ya incluye todos los archivos necesarios para Cloudflare Pages:

| Archivo | Ubicación | Propósito |
| :--- | :--- | :--- |
| `_redirects` | `public/_redirects` | Regla de reescritura `/* /index.html 200` para que las rutas del cliente (`/producto/*`, `/carrito`, `/checkout`, `/app/*`) funcionen al recargar la página. |
| `_headers` | `public/_headers` | Cabeceras de seguridad (`X-Content-Type-Options`, `X-Frame-Options`) y reglas de caché perimetral (inmutables para `/assets/*` y sin caché para `index.html`). |
| `wrangler.jsonc` | Raíz del proyecto | Archivo de configuración estándar de Wrangler para Cloudflare Pages con directorio de salida `./dist`. |
| `.nvmrc` | Raíz del proyecto | Fija la versión de Node.js en `20.19.3` para el entorno de compilación de Cloudflare. |

---

## 2. Métodos de Despliegue

### Método A: Despliegue Automático con Git (Recomendado)

1. **Subir el repositorio** a tu cuenta de GitHub o GitLab.
2. Ingresar al **[Panel de Cloudflare](https://dash.cloudflare.com/)** > **Compute (Workers & Pages)** > **Create application** > pestaña **Pages** > **Connect to Git**.
3. Seleccionar el repositorio del proyecto.
4. Configurar los parámetros de compilación (**Build settings**):
   - **Framework preset:** `Vite` (o `None`)
   - **Build command:** `pnpm build`
   - **Build output directory:** `dist`
   - **Root directory:** `/` (dejar vacío o `/`)
5. En la sección **Environment variables (Variables de entorno)**, agregar:
   - `NODE_VERSION` = `20.19.3`
   - `PNPM_VERSION` = `10.13.1`
   - `VITE_APP_MODE` = `demo` *(o `supabase` si ya conectaste la base de datos)*
6. Hacer clic en **Save and Deploy**. Cloudflare construirá y publicará la aplicación en un subdominio `*.pages.dev` con certificado SSL automático y despliegues automáticos ante cada `git push`.

---

### Método B: Despliegue Directo por Terminal (Wrangler CLI)

Si prefieres desplegar directamente desde tu máquina o entorno local:

1. **Iniciar sesión en Cloudflare:**
   ```bash
   pnpm dlx wrangler login
   ```
2. **Compilar y Desplegar:**
   ```bash
   pnpm pages:deploy
   ```
   *(El script ejecuta `pnpm build` y sube la carpeta `dist` a Cloudflare Pages de forma inmediata).*

3. **Previsualizar localmente con el emulador perimetral de Cloudflare:**
   ```bash
   pnpm pages:preview
   ```

---

## 3. Variables de Entorno en Cloudflare Pages

Puedes configurar tus variables en el panel de Cloudflare (**Settings** > **Environment variables**):

| Variable | Tipo | Descripción | Ejemplo |
| :--- | :--- | :--- | :--- |
| `VITE_APP_MODE` | Obligatoria | Modo de ejecución de la aplicación | `demo` o `supabase` |
| `VITE_BUSINESS_STORE_NAME` | Opcional | Nombre comercial de la tienda | `Impulso Suplementos` |
| `VITE_BUSINESS_WHATSAPP_PHONE` | Opcional | Teléfono internacional de WhatsApp | `5491100000000` |
| `VITE_DEFAULT_DELIVERY_FEE_CENTS` | Opcional | Costo de envío estándar en centavos | `500000` ($5.000) |
| `VITE_SUPABASE_URL` | Si usas Supabase | URL del proyecto Supabase | `https://xxxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Si usas Supabase | Clave anónima pública de Supabase | `eyJhbGciOi...` |
| `VITE_OPENAI_API_KEY` | Opcional | Clave para asistente IA de stock | `sk-proj-...` |

---

## 4. Configurar Dominio Personalizado

1. En el panel de Cloudflare Pages, ir a tu proyecto > pestaña **Custom domains**.
2. Hacer clic en **Set up a custom domain**.
3. Ingresar tu dominio (ej. `tienda.tumarca.com` o `tumarca.com`).
4. Cloudflare configurará automáticamente los registros DNS y generará el certificado SSL/TLS universal sin costo adicional.
