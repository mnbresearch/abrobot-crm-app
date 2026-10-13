/**
 * OpenAPI 3.1 description of the public REST API (supabase/functions/api).
 *
 * Served unauthenticated at GET /api/v1/openapi.json so a customer can point
 * Postman, Insomnia or a code generator straight at it.
 *
 * It must describe only what the function actually does. tests/openapi.test.cjs
 * cross-checks this file against the routes in api/index.ts in both directions:
 * every route the function serves is documented, and every documented path is
 * served. A spec that drifts from the code is worse than no spec.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errorResponses = (codes: number[]) =>
  Object.fromEntries(codes.map((c) => [String(c), {
    description: ({
      400: "Malformed request (invalid JSON, bad query parameter)",
      401: "Missing, invalid, expired or revoked API key",
      402: "Your plan does not include the API, or a plan limit was reached",
      403: "The key lacks the scope this route needs",
      404: "No such record in your organisation",
      413: "Request body larger than 64 KB",
      422: "The body is well-formed but a field is invalid",
      429: "Rate limit exceeded — see Retry-After",
      503: "Temporary failure — safe to retry",
    } as Record<number, string>)[c] ?? "Error",
    content: { "application/json": { schema: ref("Error") } },
  }]));

const bearer = [{ apiKey: [] as string[] }];

export function openapiSpec(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "AbroBot CRM API",
      version: "1.0.0",
      description:
        "Read and write the records in your AbroBot CRM workspace.\n\n" +
        "Authenticate with an API key from Settings → Integrations, sent as `Authorization: Bearer abk_live_…`. " +
        "Every request is scoped to the organisation that owns the key; there is no parameter through which another " +
        "organisation's data can be requested.\n\n" +
        "Limits: 120 requests per minute per key (429 with Retry-After beyond that), 64 KB per request body, " +
        "200 items per page. The API is included on the Business plan and above.\n\n" +
        "Idempotency: POST /leads deduplicates on email and phone within your organisation, so retrying the same " +
        "create returns the existing record (`deduped: true`) instead of a duplicate.",
    },
    servers: [{ url: serverUrl }],
    security: bearer,
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", description: "abk_live_… key from Settings → Integrations" },
      },
      schemas: {
        Error: {
          type: "object", required: ["error"],
          properties: {
            error: { type: "string" },
            hint: { type: "string" },
            details: { type: "array", items: { type: "string" } },
            request_id: { type: "string" },
          },
        },
        Pagination: {
          type: "object",
          properties: {
            total: { type: "integer" }, limit: { type: "integer" },
            offset: { type: "integer" }, has_more: { type: "boolean" },
          },
        },
        Lead: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            email: { type: ["string", "null"] },
            phone: { type: ["string", "null"], description: "E.164, e.g. +919876543210" },
            source: { type: "string" },
            stage_key: { type: "string" },
            score: { type: "integer", minimum: 0, maximum: 100 },
            assigned_to: { type: ["string", "null"], format: "uuid" },
            tags: { type: "array", items: { type: "string" } },
            custom: { type: "object", additionalProperties: true },
            target_country: { type: ["string", "null"] },
            course: { type: ["string", "null"] },
            course_level: { type: ["string", "null"] },
            intake: { type: ["string", "null"] },
            budget_inr: { type: ["number", "null"] },
            next_follow_up_at: { type: ["string", "null"], format: "date-time" },
            last_contacted_at: { type: ["string", "null"], format: "date-time" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        LeadCreate: {
          type: "object",
          description: "At least one of email or phone is required.",
          properties: {
            name: { type: "string", maxLength: 200 },
            email: { type: "string", format: "email" },
            phone: { type: "string", description: "Any common format; normalised to E.164. Bare 10-digit numbers are treated as Indian." },
            custom: { type: "object", additionalProperties: true, description: "At most 8 KB" },
          },
        },
        LeadPatch: {
          type: "object",
          description: "Only the fields you send are changed.",
          properties: {
            name: { type: "string", maxLength: 200 },
            email: { type: ["string", "null"], format: "email" },
            phone: { type: ["string", "null"] },
            stage_key: { type: "string" },
            score: { type: "integer", minimum: 0, maximum: 100 },
            assigned_to: { type: ["string", "null"], format: "uuid", description: "Must be an active member of your organisation" },
            tags: { type: "array", maxItems: 30, items: { type: "string", maxLength: 40 } },
            custom: { type: "object", additionalProperties: true },
            next_follow_up_at: { type: ["string", "null"], format: "date-time" },
          },
        },
        Stage: {
          type: "object",
          properties: {
            key: { type: "string" }, label: { type: "string" }, position: { type: "integer" },
            is_won: { type: "boolean" }, is_lost: { type: "boolean" },
          },
        },
        Conversation: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" }, lead_id: { type: ["string", "null"], format: "uuid" },
            visitor_name: { type: ["string", "null"] }, visitor_email: { type: ["string", "null"] },
            visitor_phone: { type: ["string", "null"] }, page_url: { type: ["string", "null"] },
            message_count: { type: "integer" },
            created_at: { type: "string", format: "date-time" },
            last_message_at: { type: ["string", "null"], format: "date-time" },
          },
        },
        Message: {
          type: "object",
          properties: {
            id: { type: "string" }, role: { type: "string", enum: ["user", "assistant", "system"] },
            content: { type: "string" }, created_at: { type: "string", format: "date-time" },
          },
        },
      },
    },
    paths: {
      "/openapi.json": {
        get: {
          summary: "This document", security: [], operationId: "getOpenApi",
          responses: { "200": { description: "OpenAPI 3.1 JSON" } },
        },
      },
      "/me": {
        get: {
          summary: "The organisation and permissions of the calling key — use as a health check",
          operationId: "getMe",
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  org: { type: "string" }, slug: { type: "string" }, plan: { type: "string" },
                  scopes: { type: "array", items: { type: "string" } },
                  key: { type: "object", properties: {
                    id: { type: "string", format: "uuid" }, prefix: { type: "string" },
                    expires_at: { type: ["string", "null"], format: "date-time" },
                  } },
                },
              } } },
            },
            ...errorResponses([401, 402, 404, 429, 503]),
          },
        },
      },
      "/stages": {
        get: {
          summary: "Pipeline stages, in order", operationId: "listStages",
          description: "Scope: stages:read",
          responses: {
            "200": { description: "OK", content: { "application/json": { schema: {
              type: "object", properties: { stages: { type: "array", items: ref("Stage") } } } } } },
            ...errorResponses([401, 402, 403, 429]),
          },
        },
      },
      "/leads": {
        get: {
          summary: "List records, newest first", operationId: "listLeads",
          description: "Scope: leads:read. Archived records are never returned.",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
            { name: "stage", in: "query", schema: { type: "string" } },
            { name: "assigned", in: "query", schema: { type: "string", format: "uuid" } },
            { name: "source", in: "query", schema: { type: "string" } },
            { name: "since", in: "query", description: "Created at or after (ISO 8601)", schema: { type: "string", format: "date-time" } },
            { name: "q", in: "query", description: "Search name, email and phone", schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "OK", content: { "application/json": { schema: {
              type: "object", properties: { leads: { type: "array", items: ref("Lead") }, pagination: ref("Pagination") } } } } },
            ...errorResponses([400, 401, 402, 403, 429]),
          },
        },
        post: {
          summary: "Create a record, or return the existing one with the same email/phone", operationId: "createLead",
          description: "Scope: leads:write",
          requestBody: { required: true, content: { "application/json": { schema: ref("LeadCreate") } } },
          responses: {
            "201": { description: "Created", content: { "application/json": { schema: ref("Lead") } } },
            "200": { description: "Already existed (deduped)", content: { "application/json": { schema: {
              type: "object", properties: { ok: { type: "boolean" }, deduped: { type: "boolean" }, id: { type: "string" }, message: { type: "string" } } } } } },
            ...errorResponses([400, 401, 402, 403, 413, 422, 429, 503]),
          },
        },
      },
      "/leads/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        get: {
          summary: "One record", operationId: "getLead", description: "Scope: leads:read",
          responses: {
            "200": { description: "OK", content: { "application/json": { schema: ref("Lead") } } },
            ...errorResponses([401, 402, 403, 404, 429]),
          },
        },
        patch: {
          summary: "Update a record", operationId: "updateLead", description: "Scope: leads:write",
          requestBody: { required: true, content: { "application/json": { schema: ref("LeadPatch") } } },
          responses: {
            "200": { description: "Updated", content: { "application/json": { schema: ref("Lead") } } },
            ...errorResponses([400, 401, 402, 403, 404, 413, 422, 429]),
          },
        },
      },
      "/conversations": {
        get: {
          summary: "AI chat conversations, most recent first", operationId: "listConversations",
          description: "Scope: conversations:read",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
            { name: "lead_id", in: "query", schema: { type: "string", format: "uuid" } },
            { name: "since", in: "query", schema: { type: "string", format: "date-time" } },
          ],
          responses: {
            "200": { description: "OK", content: { "application/json": { schema: {
              type: "object", properties: { conversations: { type: "array", items: ref("Conversation") }, pagination: ref("Pagination") } } } } },
            ...errorResponses([400, 401, 402, 403, 429]),
          },
        },
      },
      "/conversations/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        get: {
          summary: "A conversation and its transcript (up to 500 messages)", operationId: "getConversation",
          description: "Scope: conversations:read",
          responses: {
            "200": { description: "OK", content: { "application/json": { schema: {
              type: "object", properties: { conversation: ref("Conversation"), messages: { type: "array", items: ref("Message") } } } } } },
            ...errorResponses([401, 402, 403, 404, 429]),
          },
        },
      },
    },
  };
}
