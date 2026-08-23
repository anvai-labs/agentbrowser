# AgentBrowser: Agent-First Headless Browser

[![CI](https://github.com/yourusername/agentbrowser/workflows/CI/badge.svg)](https://github.com/yourusername/agentbrowser/actions)

AgentBrowser is an agent-native browser service designed for AI agents to safely and reliably operate authorized websites through a compact, deterministic interface.

## Status

🚧 **Under Active Development** - This is the MVP implementation following the [technical design](docs/technical-design.md) and [ADR documentation](docs/adr/).

## Vision

Traditional browsers are visual applications designed for humans. AgentBrowser reimagines the browser for AI agents:

- **Semantic observations** over screenshots
- **Stable element references** with staleness detection
- **Safety-first** with network policy and approval gates
- **Token-efficient** observations bounded by size/element count
- **Agent-focused API** designed for automation, not browsing

## Architecture

- **TypeScript** control plane and public API
- **Playwright + Chromium** for MVP browser engine
- **Engine-neutral** protocol for future engine flexibility
- **Headless-first** with semantic observations as default
- **TDD-driven** development with comprehensive test coverage

## Project Status

### Phase 0: Repository Foundation ✅ IN PROGRESS

- ✅ Monorepo setup with pnpm workspace
- ✅ Protocol schemas and types
- ✅ BrowserEngine interface definition
- ✅ FakeEngine for contract testing
- ✅ Contract test suite structure
- 🚧 Tests running (background)

### Phase 1-3: Planned (see technical design)

See [technical design](docs/technical-design.md) for full roadmap.

## Development

### Prerequisites

- Node.js 22.11.1
- pnpm 9.15.0

### Setup

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm -r build

# Run tests
pnpm -r test

# Type check
pnpm -r type-check

# Lint
pnpm -r lint
```

### Package Structure

```
agentbrowser/
├── apps/                    # Applications
│   ├── server/             # REST + WebSocket service
│   ├── cli/                # CLI tool
│   └── mcp/                # MCP server
├── packages/               # Shared packages
│   ├── protocol/           # Schemas and types
│   ├── core/               # Session management
│   ├── engine/             # Engine interface
│   ├── engine-playwright/  # Playwright adapter
│   ├── testkit/            # Testing utilities
│   └── sdk-typescript/     # TypeScript SDK
└── docs/                   # Documentation
    ├── adr/                # Architecture decisions
    ├── technical-design.md  # Implementation plan
    └── implementation-roadmap.md
```

## Documentation

- [Technical Design](docs/technical-design.md) - Full implementation plan
- [ADR Index](docs/README.md) - Architecture decision records
- [Implementation Roadmap](docs/implementation-roadmap.md) - Progress tracking

## License

Apache-2.0

## Inspired By

- [Cloudflare Kitesurf](https://blog.cloudflare.com/kitesurf/) - Stateless browser architecture
- [Playwright](https://playwright.dev/) - Browser automation foundation
- [Obscura](https://github.com/h4ckf0r0day/obscura) - Rust headless engine reference
