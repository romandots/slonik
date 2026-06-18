# SLONK-27: MCP direct file upload from ChatGPT

## Technical Task

Problem: ChatGPT MCP clients can call tools with structured JSON input, but the existing
`attach_file` flow requires a two-step upload through an external object URL. That makes
small files awkward to attach directly from the client.

Goal: extend `attach_file` with an optional direct upload mode that accepts file content
inside the MCP request while keeping the existing presign/complete flow compatible.

Requirements:
- Add optional `content_base64` to `attach_file`.
- When `content_base64` is provided, reject `object_key` and `complete`; the server must
  generate the object key itself.
- Decode only canonical standard base64, verify decoded byte length equals `size`, and
  reject invalid input without writing to MinIO or Plane comments.
- Enforce a small-file limit for direct uploads.
- Store the object in the MCP artifacts MinIO bucket with the provided MIME type.
- Return direct-upload metadata compatible with `mcp_artifact` attachments.
- Do not publish storage or presigned URLs in Plane comments.
- Preserve existing presign/complete behavior.
- Cover the new mode and rejection paths with tests.

## Implementation Notes

Implemented in branch `feature/SLONK-27-chatgpt-file-upload`.

Changed files:
- `mcp-kanban/src/tools/attach-file/schema.ts`
- `mcp-kanban/src/tools/attach-file/handler.ts`
- `mcp-kanban/src/tools/attach-file/handler.test.ts`
- `mcp-kanban/src/minio-client.ts`
- `mcp-kanban/src/tools/test-fakes.ts`
- `mcp-kanban/src/tools/registry.ts`
- `docs/SPEC.md`
- `docs/CHANGELOG.md`

Behavior:
- `attach_file` now supports `content_base64` for direct server-side uploads.
- Direct uploads are limited to 10 MiB decoded size and bounded by encoded payload length
  at schema level.
- The handler validates canonical base64 and size consistency before `MinioClient.putObject`.
- The Plane comment records filename, size, and generated `object_key`; it does not expose
  MinIO or presigned URLs.
- The old presign/complete path remains available.

Verification:
- `pnpm exec vitest run src/tools/attach-file/handler.test.ts --reporter=dot`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm exec vitest run --reporter=dot`
- `pnpm build`

