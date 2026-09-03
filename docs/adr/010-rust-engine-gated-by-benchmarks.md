# ADR-010: Rust Engine Investment Gated by Task-Success and Cost Benchmarks

**Status:** Accepted
**Context:** 2025-01-23
**Superseded by:** N/A

## Context

The long-term vision for AgentBrowser includes a custom Rust-native browser engine for cost and efficiency advantages. However, building a browser engine from scratch is an enormous undertaking:
- HTML parsing and DOM
- CSS parsing, cascading, layout
- JavaScript execution
- Rendering and rasterization
- Network stack and protocol support
- CDP protocol compatibility

This investment is only justified if measurements prove Chromium is the bottleneck. The MVP uses Playwright + Chromium to validate the product concept and gather performance data.

## Decision

**Invest in Rust-native engine only after benchmarks demonstrate Chromium cost/startup/RSS blocks target economics.**

### Decision criteria

Invest in Rust engine when ALL of these are true:

1. **Task success parity**: ≥ 95% success rate on corpus vs Chromium
2. **Cost advantage**: ≥ 30% reduction in cost per successful task
3. **Startup improvement**: ≥ 50% reduction in cold-start latency
4. **Resource efficiency**: ≥ 40% reduction in RSS per session
5. **Compatibility**: Passes capability-based test suite

### Measurement framework

```typescript
// Benchmark tasks run against real-world corpus
const BENCHMARK_METRICS = {
  // Primary: task success
  taskSuccessRate: "percentage of tasks completed successfully",

  // Secondary: cost and resources
  costPerTask: "compute cost per successful task",
  coldStartLatency: "time from create to first action",
  averageRss: "memory per concurrent session",

  // Tertiary: user experience
  p95ObservationLatency: "95th percentile observation time",
  staleTargetRate: "percentage of ref resolution failures",

  // Compatibility
  capabilities: "which browser APIs are supported",
  wptPassRate: "Web Platform Tests pass rate (if applicable)"
};
```

### Engine comparison matrix

| Metric | Playwright Chromium | Obscura (CDP) | Rust Engine (future) |
|--------|-------------------|---------------|---------------------|
| Task Success | 100% (baseline) | TBD | ≥ 95% required |
| Cold Start | ~350ms | TBD | ≤ 175ms target |
| RSS per Session | ~150MB | TBD | ≤ 90MB target |
| Cost per Task | $0.XX | TBD | -30% target |
| Compatibility | Full Web | Limited | Capability-based |

## Consequences

### Positive
- **Data-driven decision**: Invest only when justified
- **Avoid premature optimization**: Chromium is excellent for MVP
- **Clear exit criteria**: Know exactly when to switch
- **Parallel development**: Can experiment while running Chromium

### Negative
- **Uncertain timeline**: Might never meet criteria
- **Opportunity cost**: Could invest elsewhere
- **Technical debt**: If Chromium becomes entrenched, hard to replace

### Trade-offs
- Use proven Chromium now
- Defer engine investment until measurable benefit
- Accept that Rust engine might never be needed

## Rationale

### Why benchmark-driven decision

1. **Huge investment**: Browser engine is 1-2 engineer-years minimum
2. **Risk**: Might never match Chromium's compatibility
3. **Cost**: Engineer time vs compute savings
4. **Validation**: Prove the problem exists before solving

### Why these specific criteria

1. **Task success (≥ 95%)**: Agent workflows must work
2. **Cost (≥ 30%)**: Justify engineering investment
3. **Startup (≥ 50%)**: Cold-start is major friction
4. **RSS (≥ 40%)**: Memory determines concurrency
5. **Capability-based**: Don't need full Web parity

### What this enables

1. **MVP velocity**: Focus on product, not engine
2. **Fair comparison**: Measure on real agent tasks
3. **Honest assessment**: Might never switch engines
4. **Optionality**: Keep chromium as fallback

### Alternative considered: Start with Rust engine
**Rejected** because:
- Delays MVP by 6-12 months
- Web compatibility is enormous effort
- Can't validate product concept without working agent system
- Chromium solves the problem adequately today

### Alternative considered: Commit to Rust engine regardless
**Rejected** because:
- No data that Chromium is the bottleneck
- Might waste engineering on non-problem
- Chromium keeps improving too
- Cost might not matter at target scale

### Alternative considered: Never build Rust engine
**Rejected** because:
- Chromium might be too expensive at scale
- Startup time might be unacceptable
- Rust engine might enable new capabilities
- Keep option open if data supports it

## Related Decisions

- **ADR-001**: TypeScript Playwright MVP - defines starting point
- **ADR-002**: Engine-neutral contract - enables engine swap
- **Spec Section 20**: Rust-native engine track

## Implementation Notes

### Benchmark harness

```typescript
// tests/performance/engine-benchmark.ts
interface EngineBenchmark {
  name: string;
  engine: BrowserEngine;

  // Run benchmark tasks
  run(corpus: Task[]): Promise<BenchmarkResult>;
}

interface BenchmarkResult {
  engineName: string;
  taskSuccessRate: number;  // 0-100
  costPerTask: number;  // in USD
  coldStartLatency: number;  // in ms
  averageRss: number;  // in MB
  p95ObservationLatency: number;  // in ms
  staleTargetRate: number;  // 0-100
  capabilities: EngineCapabilities;
}

async runEngineComparison(): Promise<BenchmarkResult[]> {
  const engines = [
    new PlaywrightEngine(),
    new ObscuraEngine(),
    // new RustEngine() in future
  ];

  const corpus = await loadBenchmarkCorpus();

  return await Promise.all(
    engines.map(async engine => {
      const benchmark = new EngineBenchmark(engine);
      return await benchmark.run(corpus);
    })
  );
}

async decideOnRustEngine() {
  const results = await runEngineComparison();
  const chromium = results.find(r => r.engineName === "playwright-chromium");
  const rust = results.find(r => r.engineName === "rust-engine");

  if (!rust) {
    console.log("Rust engine not available yet");
    return;
  }

  const meetsCriteria =
    rust.taskSuccessRate >= 95 &&
    rust.costPerTask <= chromium.costPerTask * 0.7 &&
    rust.coldStartLatency <= chromium.coldStartLatency * 0.5 &&
    rust.averageRss <= chromium.averageRss * 0.6;

  if (meetsCriteria) {
    console.log("✓ Rust engine meets investment criteria");
    await createADR("start-rust-engine-development");
  } else {
    console.log("✗ Rust engine does not meet criteria");
    console.log("Continue with Playwright Chromium");
  }
}
```

### Capability-based comparison

```typescript
// Don't require full Web parity
// Route based on capabilities
interface EngineRouting {
  selectEngine(task: AgentTask): BrowserEngine;
}

class SmartEngineRouter implements EngineRouting {
  selectEngine(task): BrowserEngine {
    // Rust engine for compatible tasks
    if (task.requiresOnly([
      "static-html",
      "forms",
      "links",
      "navigation",
      "extraction"
    ])) {
      return this.rustEngine;
    }

    // Chromium for complex tasks
    if (task.requiresAny([
      "webgl",
      "video",
      "webrtc",
      "complex-js",
      "cdp"
    ])) {
      return this.chromiumEngine;
    }

    // Default to Chromium for safety
    return this.chromiumEngine;
  }
}
```

### Experimental phases

```typescript
// Phase 1: Static HTML only
const RUST_PHASE_1_CAPABILITIES = {
  supportsStaticHtml: true,
  supportsForms: true,
  supportsLinks: true,
  supportsNavigation: true,
  // No JS, no video, no WebGL
};

// Phase 2: JavaScript + DOM
const RUST_PHASE_2_CAPABILITIES = {
  ...RUST_PHASE_1_CAPABILITIES,
  supportsJavascript: true,
  supportsDomMutation: true,
  supportsFetch: true,
};

// Phase 3: Layout + Screenshots
const RUST_PHASE_3_CAPABILITIES = {
  ...RUST_PHASE_2_CAPABILITIES,
  supportsLayout: true,
  supportsScreenshots: true,
  supportsPdf: true,
};
```

### Documentation requirements

Before starting Rust engine:

1. **Benchmark results**: Publish full comparison
2. **Cost analysis**: ROI calculation
3. **Timeline estimate**: Engineering effort
4. **Risk assessment**: What could go wrong
5. **Fallback plan**: Keep Chromium as backup

Create an ADR at the next free number when criteria met: "Begin Rust Engine Development" (011 was consumed twice by parallel branches — resolved 2026-09-03 — so pre-announcing numbers is retired)

### Validation criteria

- Benchmark harness runs on all engines
- Results published before engine decision
- Clear pass/fail criteria documented
- No Rust engine work until criteria met
- Chromium remains production engine
- Engine contract enables transparent swap
