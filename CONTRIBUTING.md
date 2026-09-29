# Contributing to linear-eye

Bug reports, documentation improvements, and focused pull requests are welcome. Use English for project documentation, issues, pull requests, and user-facing messages.

## Development setup

Use Node.js 22 or newer and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

The test suite uses real local D1 through the Cloudflare Workers test pool. It does not require production credentials. The build command performs a deployment dry run. See the [README](README.md#local-development) for running a local Worker and the [verification record](docs/verification.md) for the test runtime's compatibility-date limitation.

## Scope and design

- Keep Linear as the source of truth. The MVP is a read-only service for one workspace.
- Keep MCP and Cloudflare entrypoints thin. Put application logic in Effect services and inject dependencies through Layers.
- Validate external inputs with Effect Schema and bind SQL values as parameters.
- Preserve atomic writes, delivery deduplication, snapshot version guards, and honest reporting coverage.
- Let Cloudflare Queues and Cron own durable retries and scheduling.
- Exclude issue descriptions and comments from storage and logs. Do not add individual productivity scores or LLM calls.

The [MVP specification](docs/mvp-spec.md) describes the product contract. [Effect architecture decisions](docs/effect-direction.md) explains the service boundaries and runtime choices.

## Submitting changes

Open an issue for a substantial product or architecture change before implementing it. For a bug, describe the observed behavior, expected behavior, and a minimal reproduction. Use synthetic or redacted data.

Keep each pull request focused. Explain what changes, why it is needed, and how it was verified. Add regression coverage for behavior changes and update documentation when commands, configuration, or report semantics change. Add a new SQL migration for schema changes instead of editing an applied migration.

Do not commit credentials, `.dev.vars`, `.env` files, local D1 databases, or real workspace payloads. Avoid including secrets or private issue content in public issues and pull requests.

## License

This project is distributed under the [MIT License](LICENSE).
