# Contrato de errores visibles

Las fronteras HTTP/RPC clasifican errores como validación, autenticación, autorización, regla comercial, dependencia temporal o defecto inesperado.

La UI recibe:

```ts
type PublicError = {
  kind: 'validation' | 'auth' | 'permission' | 'business' | 'temporary' | 'unexpected'
  message: string
  nextAction?: string
  retryable: boolean
}
```

Nunca se muestran SQL, PostgREST, nombres de RPC, claves, UUID, stack traces, modelos internos ni códigos HTTP. Los logs tampoco guardan secretos, prompts completos ni resultados financieros de IA.

