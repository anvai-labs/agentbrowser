# Playwright lifecycle integration inquiry

Status: **Owner authorized outreach; message prepared, not submitted.**
Checked 2026-09-07. Playwright's
[question template](https://github.com/microsoft/playwright/blob/main/.github/ISSUE_TEMPLATE/question.yml)
asks users not to submit support questions as issues and directs them to its
[Discord support channel](https://aka.ms/playwright/discord). No connected Discord
tool/account is available in this workspace. Do not bypass that routing by
mislabeling this question as a bug or feature request.

Searches for worker interception, CDP sessions and auto-attachment found no
matching open integration discussion. The historical
[worker importScripts issue](https://github.com/microsoft/playwright/issues/6403)
was resolved in 2021; it is not evidence of our present problem and should not
be reopened. This search is bounded, not an exhaustive duplicate guarantee.

## Message ready for the support channel

We maintain an agent-native browser service using Playwright's Chromium engine
and are evaluating a supported integration path for network-policy enforcement.
We want to preserve Playwright's normal actions, observations and browser
semantics rather than patch its private target lifecycle implementation.

Does Playwright offer, or recommend an integration point for, both of these
distinct controls?

1. Coordinate asynchronous target initialization before untrusted execution,
   including nested workers, frames/popups and the supported service-worker
   lifecycle. Setup failure or disconnect must not implicitly release work.
2. Admit initial document/worker-script network requests before connection,
   including requests that precede an execution pause. We do not assume that
   pausing a worker also pauses its initial script download.

Our diagnostic environment is Playwright 1.62.1, Chromium headless-shell
151.0.7922.34 (revision 1234), Node 24.11.1 on macOS arm64. Native HTTP worker
controls use only a synthetic loopback fixture. With Playwright plus an extra
public CDP session, attached workers made sentinel requests before our client's
release command. A direct-owned Chromium comparison using one or two separate
raw CDP sockets did not reproduce that ordering. The connection/session topology
and launch settings differ, so we have not isolated a cause or attributed a
Playwright bug. Initial worker-script requests preceded execution release in
the latter comparison.

We found Page/Frame CDP access and worker observation APIs, but no documented
pre-resume coordination contract. Are there supported hooks or an existing
discussion we should use? Which ordering, cancellation and target-coverage
guarantees can an integration rely on? A pointer confirming this is outside
the supported API would also help us make an explicit maintenance decision.

We are not asking the proxy or debugger pause to establish complete containment:
browser-semantic policy and an OS-enforced network boundary remain separate
requirements. We can provide a small synthetic reproducer and command chronology
if useful. No private browsing data is involved.

## Follow-up boundary

Record the channel/thread link and the actual response when sent. Do not mark
support confirmed merely because a message was delivered. A maintainer proposal
still requires the pinned-version acceptance tests in the
[integration contract](transport-integration-contract.md). This authorization
does not cover a fork, private patch, replacement engine, broad dataset upload,
or a new experiment. Keep unrelated local policy findings out of this inquiry.
