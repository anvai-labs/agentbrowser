# Node 24 baseline evidence

Date: 2026-09-20. Scope: T9 runtime baseline candidate. This record does not qualify a
release or change the published Node minimum.

## Version choice

The [official release schedule](https://github.com/nodejs/Release/blob/main/schedule.json)
keeps Node 24 (Krypton) in LTS through 2028-04-30. Node 26 remains Current until its
scheduled LTS transition on 2026-10-28. The
[official v24 archive](https://nodejs.org/download/release/latest-v24.x/) identifies
24.21.0 as the latest Node 24 patch on the audit date. The repository therefore pins
24.21.0 rather than floating `latest` or moving production qualification to Node 26.
All eleven CI/release setup-node steps consume the existing `.tool-versions` file,
which also owns the local development pin. This avoids eleven independently maintained
version literals. The Docker build image retains its explicit matching version.
Refresh the patch pin at release checkpoints and when relevant security fixes land.

## Runtime inspection

The tagged Playwright 1.62.1
[Noble Dockerfile](https://github.com/microsoft/playwright/blob/v1.62.1/utils/docker/Dockerfile.noble)
sets `NODE_VERSION=24` and installs Node from the NodeSource 24.x repository. Inspection
of both platform manifests under immutable multi-architecture image digest
`sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e`
found `nodejs 24.18.1-1nodesource1` and npm 11.16.0 on amd64 and arm64. The Dockerfile
pins that digest and the existing container smoke asserts runtime major 24. It does not
install a second Node copy merely to force patch equality with the build stage.

## Compatibility and acceptance

The root `engines.node >=22.0.0`, package-specific engine declarations, Node 22 type
libraries and lockfile stay unchanged. They preserve the published compatibility and
compile-time API floors; they are not evidence that every runtime path still works on
Node 22.

Node 24.21.0 has passed the workspace build and 74 focused helper/context tests locally.
Its first run caught a duplicate-SIGTERM race in the recipe wrapper; that fix is
qualified on both Node 22 and 24 in the preceding recipe change.

Before merge, qualification requires one bounded Node 22 build/package-acceptance run,
then the existing Node 24 type, lint, unit, build, compiled-client, extracted-server and
Docker jobs. The package acceptance report already records its exact Node runtime. The
exact candidate commit, CI runs and final results are recorded in the PR delivery
record after those gates settle.
