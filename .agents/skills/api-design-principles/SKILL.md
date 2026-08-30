---
name: api-design-principles
description: >-
  Design consistent REST and GraphQL APIs. Use when designing, reviewing, or refactoring API endpoints, schemas, request/response payloads, HTTP status codes, pagination, and error handling.
---

# API Design Principles

Guidelines and best practices for building robust, scalable, developer-friendly REST and GraphQL APIs.

## 1. RESTful URL & Resource Structure

- **Use nouns in plural** for resources: `/api/v1/products`, `/api/v1/orders`.
- **Hierarchical nesting** for sub-resources: `/api/v1/users/{id}/orders` (limit nesting to 2 levels max).
- **Use query parameters** for filtering, sorting, and pagination:
  - `GET /api/v1/products?category=whey&sort=-price&limit=20&page=1`
- **Use standard HTTP Methods**:
  - `GET`: Read (idempotent, cacheable)
  - `POST`: Create / Non-idempotent action
  - `PUT`: Full update / Replace (idempotent)
  - `PATCH`: Partial update (idempotent)
  - `DELETE`: Remove resource (idempotent)

## 2. HTTP Status Code Conventions

| Code | Meaning | When to Use |
| :--- | :--- | :--- |
| `200 OK` | Success | Standard response for successful `GET`, `PUT`, `PATCH`. |
| `201 Created` | Created | Resource successfully created via `POST`. Include `Location` header or created object. |
| `204 No Content` | No Content | Successful action returning no body (e.g. `DELETE`). |
| `400 Bad Request` | Bad Request | Malformed JSON, validation failure on client input. |
| `401 Unauthorized` | Unauthenticated | Missing or invalid authentication token. |
| `403 Forbidden` | Forbidden | Authenticated user lacks permission for this resource. |
| `404 Not Found` | Not Found | Requested endpoint or resource ID does not exist. |
| `409 Conflict` | Conflict | Duplicate unique field (e.g. email already exists), state conflict. |
| `422 Unprocessable`| Semantic Error | Valid syntax but failed business logic / semantic validation. |
| `429 Too Many Req`| Rate Limited | Client exceeded rate limits. Include `Retry-After`. |
| `500 Server Error` | Internal Error | Unhandled server error (never leak raw stack traces). |

## 3. Standardized Response Envelope & Error Format

### Success Response
```json
{
  "data": {
    "id": "prod_123",
    "name": "Whey Isolate Protein",
    "price": 49.99
  },
  "meta": {
    "timestamp": "2026-08-29T03:35:00Z"
  }
}
```

### RFC 7807 Error Response
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The provided input data failed validation.",
    "details": [
      {
        "field": "email",
        "issue": "Invalid email address format"
      }
    ],
    "requestId": "req_8f1a7b"
  }
}
```

## 4. Pagination Patterns

### Cursor-Based (Recommended for real-time / high-scale)
```json
{
  "data": [...],
  "pagination": {
    "nextCursor": "eyJpZCI6MTIzfQ==",
    "hasMore": true,
    "limit": 20
  }
}
```

### Offset / Page-Based (Simple listings)
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "perPage": 20,
    "totalCount": 150,
    "totalPages": 8
  }
}
```

## 5. Security & Robustness Checklist

1. **Authentication & Authorization**: Validate JWT / Session tokens on every protected route with middleware.
2. **Input Validation**: Use schema validators (e.g. Zod, Joi, class-validator) before processing payload.
3. **Idempotency Keys**: Use `Idempotency-Key` header on critical mutating operations (payments, orders).
4. **CORS & Headers**: Strict CORS origin configuration, security headers (`Helmet`, `HSTS`, `X-Content-Type-Options`).
5. **Rate Limiting**: Apply sliding-window or token-bucket rate limiting to public endpoints.
