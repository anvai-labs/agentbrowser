# ADR-017: Default Server Port Moves from 3000 to 5709

**Status:** Accepted (owner-directed 2026-09-08)
**Context:** 2026-09-08
**Related:** [docs/operations.md](../operations.md) (PORT / AGENTBROWSER_BASE_URL)

## Context

The server's default port was `3000`, one of the most contested ports in
local development: Grafana, Next.js/Express dev servers, and countless
tutorials and tools bind it first. On developer machines this turns
"start the server" into "why is my port taken" archaeology. The value is
configurable (`PORT` env, `options.port`), but a default that collides
this often is a bad default.

## Decision

The default port becomes **5709** (`options.port` and `PORT` env still
override). Selection criteria and the analysis:

1. **Outside ephemeral ranges on both major platforms.** Linux defaults
   to 32768–60999, macOS to 49152–65535. Anything in those ranges can be
   handed to an outbound connection at any moment, so the server would
   randomly fail to bind at startup. Candidates above 32768 (e.g. 65530)
   were rejected on macOS alone; 5709 clears both floors with a wide
   margin.
2. **Unassigned in the IANA registry** (checked against the full
   service-names-port-numbers CSV): no TCP/UDP entry for 5709 or its ±3
   neighborhood, so no adjacent-port typos hit another service.
3. **No real-world squatter.** IANA-free is not free — Vite (5173),
   Selenium (4444), and Ollama (11434) all squat unassigned ports. Each
   finalist was checked against live usage:
   4610 → QualiSystems TestShell (4610–4640); 6710 → Axway Gateway SFTP +
   MoneyWorks Datacentre; 9325 → ElasticMQ UI; 10400 → Home Assistant
   Wyoming/OpenWakeWord; 12500 → FileCatalyst Central; 15100 → Teltonika
   RMS. 5709's only observed user is a single hobby GitHub project.
4. **Local-host sanity:** not bound by anything on the development
   machine (which itself listens on 3000, 3100, 3900, 4226, 5000, 5432,
   7000, 8080, 8123, 9200, 11000/11001, 11434).

## Consequences

- **Breaking change for anyone relying on the implicit default:** CLI,
  MCP adapter, TypeScript SDK, Docker image, and docs all moved together
  in one commit so no surface disagrees. Clients that set
  `AGENTBROWSER_BASE_URL` / `--base-url` / `baseUrl` are unaffected.
- Version skew between an old client and a new server (or vice versa)
  now surfaces as connection refused instead of silently talking to some
  unrelated service on 3000 — an improvement.
- `PORT` env, `options.port`, and `--base-url` behavior unchanged; the
  Docker image pins `PORT=5709` explicitly and its healthcheck follows.
