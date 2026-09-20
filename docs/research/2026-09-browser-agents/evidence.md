# Evidence and search method

Reviewed 20 September 2026. This is a targeted landscape review, not an exhaustive
systematic review or an independent replication. Recommendations in the overview and
experiments are AgentBrowser design inferences, not results claimed by these papers.

## Retrieval method

Successfully used the user-provided authenticated LAN paper-search API without SSH.
Its OpenAPI schema exposes `GET /api/search` with `q`, optional `cat`, and `k`.
No separate vector/multisearch endpoint, date filter, or corpus freshness guarantee
was advertised. Backend vector/multisearch behavior was not independently inspected.
Twelve targeted queries returned 55 result entries before deduplication. Ranked
similarity scores were treated as discovery signals, not confidence or quality scores.

Queries covered browser/form benchmarks; dynamic widgets and repeated labels;
memory/skill cost; prompt injection and origin isolation; UI/API tools; recovery;
human intervention; structured autofill; and authorized security/privacy testing.
Some high-ranked results were off-topic or lacked abstracts. Primary arXiv pages,
selected full texts and official standards were therefore used to check important
claims and publication versions. For example, the memory-budget paper's current v2
describes four WebArena domains, while an older search excerpt describes three.

The newest included papers were submitted 16–17 September 2026. This does not prove
coverage of every publication through the review date. No private project data or
credential was submitted to public search; LAN queries contained generic topics only.

The service is accessible from this machine's network. A future remote session still
needs a route to that private network and an authorized credential. “No SSH” does not
mean the private address is reachable from any internet location. Keep credentials
in the operator's secret facility, not repository instructions or reusable prompts.

For a future agent session, provide `PAPER_SEARCH_URL` and `PAPER_SEARCH_TOKEN` through
that session's trusted configuration. A minimal read-only query uses the existing API:

```sh
printf 'Authorization: Bearer %s\n' "$PAPER_SEARCH_TOKEN" |
  curl --fail --silent --show-error --connect-timeout 5 --max-time 30 \
    --header @- --get --data-urlencode 'q=browser agents form filling verification' \
    --data-urlencode 'k=5' "${PAPER_SEARCH_URL%/}/api/search"
```

Do not enable shell tracing around secrets. Submit only generic research queries,
bound the result count, deduplicate by arXiv ID, and verify source versions before
making claims. Query expansion can use this endpoint repeatedly; a separate client,
MCP registration, SSH session or runtime dependency is unnecessary.

## Reliability and evaluation

| ID | Primary source and date | Finding used; limitation |
| --- | --- | --- |
| E1 | [WAREX](https://arxiv.org/abs/2510.03285), 28 Sep 2025 | Perturbs existing browser benchmarks with operational failures and finds reduced success. Basis for fault injection, not a production reliability estimate for our service. Abstract reviewed. |
| E2 | [Wuying-Browser-Agent](https://arxiv.org/abs/2608.17319), 18 Aug 2026 | Combines a structured harness, recovery-oriented training and long-horizon evaluation. Its BrowserBench has 350 tasks averaging 37.9 steps. Model/training results are not portable guarantees for our harness. Abstract reviewed. |
| E3 | [CAP](https://arxiv.org/abs/2608.08392), 9 Aug 2026 | Evaluates rich interactions and perception across 420 tasks/108 sites. Supports testing complex controls and cross-site behavior; its agent-judge evaluation cannot substitute for our independent application receipts. Abstract reviewed. |
| E4 | [WebSP-Eval v2](https://arxiv.org/abs/2604.06367v2), revised 16 Jun 2026 | Security/privacy settings tasks reveal difficulty with stateful controls, particularly toggles. This is user-facing configuration evaluation, not a penetration-testing benchmark. Abstract reviewed. |

## Observation and memory

| ID | Primary source and date | Finding used; limitation |
| --- | --- | --- |
| E5 | [Read More, Think More](https://arxiv.org/html/2604.01535v1), 2 Apr 2026 | WorkArena L1 experiments find model-dependent benefits from richer HTML and efficient observation history via diffs. Scope is one platform, ID-based grounding and at most 15 steps; layout causality and longer histories remain unproven. Full experiment/limitations sections reviewed. Do not infer that full HTML is always best. |
| E6 | [Are Online Skill and Memory Modules Always Worth Their Tokens? v2](https://arxiv.org/abs/2606.15017v2), revised 30 Aug 2026 | Under matched total inference budgets, a vanilla actor matches or exceeds tested augmentations in aggregate across the reported settings. Count augmentation overhead and run variance. This does not establish that all memory is harmful. Current abstract reviewed. |
| E7 | [EconSkills](https://arxiv.org/html/2609.19523v1), 17 Sep 2026 | Verified parameterized procedures transfer when well matched; approximate retrieval and full-library delivery can offset gains. One backbone/benchmark and limited repeats constrain generalization. Coverage and limitations sections reviewed. Distinguish known-match transfer from end-to-end retrieval quality. |

## Interfaces and tool design

| ID | Primary source and date | Finding used; limitation |
| --- | --- | --- |
| E8 | [Terminal Agents Suffice for Enterprise Automation v3](https://arxiv.org/abs/2604.00073v3), revised 5 Aug 2026 | Reports strong enterprise automation using terminal/filesystem access to APIs. Supports testing our CLI/API path; an API result is not UI regression coverage, nor proof that CLI universally beats MCP. Under-review preprint; abstract reviewed. |
| E9 | [The Tool Illusion v2](https://arxiv.org/html/2604.03465v2), revised 16 Jul 2026 | Controlled study challenges uniform benefits of synthesized tools and examines coverage, complexity and overhead. Supports small composable operations and equal-budget comparisons rather than catalog growth. Introduction and study structure reviewed; no numeric gain adopted. |

## Trust and security

| ID | Primary source and date | Finding used; limitation |
| --- | --- | --- |
| E10 | [Untrusted Content Masking](https://arxiv.org/html/2607.05277v1), 6 Jul 2026 | Separates observation of untrusted regions from privileged action, optionally using restricted typed answers. Evaluations include explicitly labeled sites and a hand-labeled GitLab proxy. Correct trust boundaries matter; typed answers can still carry maliciously wrong data. Threat/evaluation/data-flow sections reviewed. This is not a universal prompt-injection guarantee for arbitrary DOM. |
| E11 | [WAAA!](https://arxiv.org/abs/2605.05509), 6 May 2026 | Extends the browser-agent threat model beyond prompt injection to traditional web deception. Supports testing UI overlays, misleading actions and origin changes. Abstract reviewed; no new live attack authorized. |
| E12 | [WebMCP Tool Surface Poisoning](https://arxiv.org/abs/2606.06387), 4 Jun 2026 | Describes mid-session manipulation of tool lifecycle and metadata. Treat tool names, descriptions, schema and read-only hints as untrusted inputs; registration is not authority. Abstract reviewed. |
| E13 | [WebMCP-Phalanx](https://arxiv.org/abs/2608.24017), 25 Aug 2026 | Proposes provenance-bound tooling and separated inspection/execution. Also reports an adaptive attack through names before inspection. Supports pre-invocation lifecycle gates, not automatically adopting a second model or claiming complete protection. Abstract reviewed. |
| E14 | [Symbolic Temporal Supervision of LLM Agents Using Contracts](https://arxiv.org/abs/2609.18128), 16 Sep 2026 | Uses the same finite-trace contract automaton for online action gating and offline trace evaluation. Motivates checking shared transition semantics in our existing authority/tests. New preprint; abstract reviewed, no formal guarantee or LTL framework adopted. |

## Standards and adjacent evidence

| ID | Source | Implication and limit |
| --- | --- | --- |
| S1 | [WebMCP specification](https://webmachinelearning.github.io/webmcp/), Draft Community Group Report dated 17 Sep 2026 | Document-local JavaScript tools are a possible future adapter. The document explicitly is not a W3C Standard or on the W3C Standards Track. Recheck the current API and implementation support before a spike; do not confuse it with the separately titled 2025 “webMCP” paper. |
| S2 | [WebDriver BiDi](https://www.w3.org/TR/2026/WD-webdriver-bidi-20260909/), Working Draft dated 9 Sep 2026 | Vendor-spanning bidirectional automation is relevant to the existing Firefox adapter. A protocol specification does not prove implementation parity or hostile-network containment. |
| E15 | [Asuka-Bench](https://arxiv.org/abs/2606.05920), 4 Jun 2026 | Evaluates underspecified web-development intent through iterative code/UI testing and feedback. Supports investigating the developer-regression use case; simulated feedback is not customer demand or proof of genuine human co-design. Abstract reviewed. |
| E16 | [Step-level Optimization for Efficient Computer-use Agents](https://arxiv.org/abs/2604.27151), 29 Apr 2026 | Proposes selective escalation at stalls and milestones instead of uniform expensive inference. A possible harness experiment only; learned monitoring must not replace required deterministic verification. Abstract reviewed. |

## Interpretation limits

No combined leaderboard, aggregate accuracy or market-size estimate is calculated:
the workloads, models, budgets, judges and dates differ. No benchmark code or model
weights were downloaded, no live application forms submitted, and no research model
was loaded. Paper evidence motivates falsifiable local experiments; installed
capability and release claims require AgentBrowser's own gates.
