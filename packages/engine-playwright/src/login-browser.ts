import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium } from 'playwright';
import {
  type ChromeBinaryPreference,
  compareChromeVersion,
  extraChromiumArgs,
  loginLaunchTimeout,
  parseChromeVersion,
  type ResolvedChromeBinaryPreference,
  resolveBrandedChrome,
  resolveChromeBinaryPreference,
  SLOW_LOGIN_LAUNCH_MS,
} from './chrome-binary.js';

/**
 * TD-BROWSER-16 phase 4 (ADR-025 §1): the operator's login browser.
 *
 * A pipe-connected PERSISTENT Chromium context over a dedicated profile
 * directory — Playwright drives `--remote-debugging-pipe`, so NO debugging
 * port is ever opened (asserted by test). It is not a session: no id, no
 * refs, no pages on any agent surface; only operator routes touch it.
 *
 * Profile security:
 * - POSIX: the directory is created 0700 and startup refuses anything wider.
 * - Windows: created with a protected DACL holding only the owner's ACE
 *   (ContainerInherit | ObjectInherit); startup parses the DACL and refuses
 *   any ACE beyond the owner — SYSTEM and Administrators are reported, not
 *   refused. The Windows CI job runs this suite (headless env), which is
 *   where the win32 branches execute.
 *
 * Binary pinning (ADR-025 §1): the resolved executable's path AND file
 * identity (size + mtime) are recorded at first launch. Identity is the GATE,
 * not the verdict — a change routes to adjudication rather than refusing
 * outright, because the ADR's rule is "refuses if that binary's version has
 * moved backwards" and branded Chrome self-updates in place constantly.
 *
 * A same-path identity change is decided by comparing versions, read with a
 * `chromium.launch()` probe on a THROWAWAY profile so an unvetted binary never
 * opens the login profile: forward adopts, backwards refuses
 * LOGIN_BINARY_DOWNGRADED, and the same version with different bytes refuses
 * LOGIN_BINARY_CHANGED (a replacement, not an update). A path change adopts
 * once when either side is a Playwright-managed build — our own resolution
 * changing — and refuses otherwise. The probe uses Playwright's pipe rather
 * than a subprocess, so the old objection that `chrome.exe --version` prints
 * nothing on Windows (GUI-subsystem exe, runner-proven) does not apply.
 *
 * Concurrency: open/close/read are serialized on an in-process lock, and a
 * stale `LOCK` file whose owner PID is gone is adopted; a live owner refuses
 * with LOGIN_PROFILE_IN_USE.
 */

export class LoginBrowserError extends Error {
  constructor(
    public code:
      | 'LOGIN_BROWSER_CLOSED'
      | 'LOGIN_PROFILE_IN_USE'
      | 'LOGIN_PROFILE_MODE'
      | 'LOGIN_BROWSER_DISPLAY'
      | 'LOGIN_BINARY_CHANGED'
      | 'LOGIN_BINARY_DOWNGRADED'
      | 'LOGIN_HOSTED_OR_MULTI_TENANT',
    message: string
  ) {
    super(message);
    this.name = 'LoginBrowserError';
  }
}

/**
 * ADR-025 §1: Playwright's Chromium defaults DISABLE these three, which
 * breaks login walls (Safe Browsing, component and background updates).
 * They are REMOVED from the launch via ignoreDefaultArgs — adding them back
 * as args would only duplicate the disable. The committed argv test asserts
 * the live process carries none of them and DOES carry the pipe flag.
 */
const LOGIN_BROWSER_DISABLE_FLAGS = [
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-background-networking',
] as const;

export interface LoginCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

export interface ReadLoginCookiesResult {
  cookies: LoginCookie[];
  /** Partitioned or expired cookies skipped, with counts only (never names). */
  skipped: { partitioned: number; expired: number };
}

export interface LoginBrowserOptions extends ChromeBinaryPreference {
  /** The profile directory; created owner-only on first use. */
  profileDir: string;
  headless?: boolean;
  now?: () => number;
  /**
   * Test seam for Chrome's ProcessSingleton owner check. Production uses the
   * real process-name probe; a test cannot arrange for a pid it does not own
   * to look like a browser, and without this the class-level `live` refusal
   * would be untestable (round-2 review finding 2).
   */
  isBrowserPid?: (pid: number) => Promise<boolean>;
  /**
   * How long a launch may take, in ms. Env fallback
   * AGENTBROWSER_LOGIN_LAUNCH_TIMEOUT_MS; see loginLaunchTimeout().
   */
  loginLaunchTimeoutMs?: number;
}

interface ProfilePin {
  /** The exact executable that last wrote the profile (pinned). */
  executable?: string;
  /**
   * The pinned executable's file identity. The same path with a different
   * identity means the binary was replaced in place — how Chrome
   * self-updates — which routes to a version comparison rather than a
   * refusal. Identity is the cheap gate that decides whether to adjudicate at
   * all; `chromiumVersion` is what the verdict compares.
   */
  executableSize?: number;
  executableModifiedMs?: number;
  /**
   * Chromium's own version at pin time. ADR-025 §1's rule is "refuses if that
   * binary's version has moved backwards", and this is the field that answers
   * it when a same-path binary is replaced in place (a Chrome self-update).
   */
  chromiumVersion?: string;
  /**
   * Audit trail for an automatic re-pin: the superseded executable (only
   * meaningful for a path change) and version, and when. Carried forward
   * across later launches so the record is durable rather than lasting a
   * single open (review finding 7).
   */
  adoptedFromExecutable?: string;
  adoptedFromVersion?: string;
  adoptedAtMs?: number;
  /**
   * Launch counter, for the record. It is NOT compared: detecting a
   * restored-from-backup profile by a decreasing count would need state kept
   * outside the profile, which there is none of — the previous comment here
   * claimed that detection, and nothing implemented it.
   */
  launches: number;
}

const LOCK_POLL_MS = 50;
const LOCK_TIMEOUT_MS = 5_000;

export class LoginBrowser {
  private context: BrowserContext | undefined;
  private closing: Promise<void> | undefined;
  /** In-process queue so open/close/read never interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * ADR-016 preference with env defaults applied once, through the same
   * helper the engine constructor uses, so a session and the login browser
   * cannot drift on what AGENTBROWSER_CHROME_PATH / _PREFER_BUNDLED mean.
   *
   * ADR-025 §1's "resolved once at enablement" is implemented by the PIN, not
   * by caching a path here: the constructor cannot be async, and Chrome may be
   * installed after the server starts. A binary swapped mid-run trips
   * LOGIN_BINARY_CHANGED, which is the guarantee the ADR is really asking for.
   */
  private readonly chromePreference: ResolvedChromeBinaryPreference;
  /** Resolved once: an invalid explicit value must fail at construction. */
  private readonly launchTimeoutMs: number;

  constructor(private readonly options: LoginBrowserOptions) {
    this.chromePreference = resolveChromeBinaryPreference(options);
    this.launchTimeoutMs = loginLaunchTimeout(options.loginLaunchTimeoutMs);
  }

  /**
   * Record how long the launch took, so a slow open reads as "41s" in the
   * service log rather than as a hang.
   *
   * The whole reason this defect survived two debugging sessions is that the
   * login launch logged nothing, leaving the session path's binary line as
   * the only evidence — and it described a different launch entirely. Elapsed
   * time is the other half of fixing that.
   */
  private reportLaunchElapsed(elapsedMs: number): void {
    const seconds = (elapsedMs / 1000).toFixed(1);
    if (elapsedMs < SLOW_LOGIN_LAUNCH_MS) {
      console.info(`[agentbrowser] login browser opened in ${seconds}s`);
      return;
    }
    console.warn(
      `[agentbrowser] login browser took ${seconds}s to open (budget ${(this.launchTimeoutMs / 1000).toFixed(0)}s). A server started by launchd/brew services is much slower here than one started from a shell; a large profile adds more. Raise AGENTBROWSER_LOGIN_LAUNCH_TIMEOUT_MS if it approaches the budget — see docs/use-your-login-safely.md.`
    );
  }

  /**
   * Live, not merely bookkept. The 'close' handler below clears `context`,
   * but a SIGKILLed or pipe-wedged Chrome can leave it set — and this getter
   * is what the ADR-025 §3 handoff floor consults, so bookkeeping would let a
   * dead browser satisfy the floor.
   *
   * Deliberately pure and synchronous: `isConnected()` reads a local flag, and
   * packages/api/src/service.ts declares this dependency as
   * `readonly isOpen: boolean`. Every side effect lives in the reap.
   */
  get isOpen(): boolean {
    return this.context !== undefined && contextDisconnected(this.context) !== true;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async open(): Promise<void> {
    return this.serialize(() => this.openLocked());
  }

  private async openLocked(): Promise<void> {
    // ADR-025 §1: "a second open while one is running is a no-op" — but only
    // while it is RUNNING. A dead-but-unbookkept context used to make that
    // branch mean "you can never reopen", so reap before consulting it.
    await this.reapDeadContext();
    if (this.context !== undefined) return;
    if (this.closing !== undefined) await this.closing;
    await this.assertProfileSecure();
    await this.assertChromeSingletonFree();
    const pin = await this.readPin();
    const headless = this.options.headless ?? false;
    if (!headless && !displayAvailable()) {
      throw new LoginBrowserError(
        'LOGIN_BROWSER_DISPLAY',
        'the login browser needs a display; run headed on a machine with one'
      );
    }
    const {
      path: executablePath,
      identity,
      pinUpdate,
      probedVersion,
      selection,
    } = await this.resolvePinnedExecutable(pin);
    // ADR-025 §1 says the login browser reuses the headed launch arguments,
    // so the operator's AGENTBROWSER_CHROMIUM_ARGS escape hatch applies here
    // too — an operator who needs a Chromium flag needs it most in the one
    // browser built for logging in. No --start-maximized: that is a session
    // window-shape choice, not a login one.
    const args = [
      '--disable-blink-features=AutomationControlled',
      ...extraChromiumArgs(process.env.AGENTBROWSER_CHROMIUM_ARGS),
    ];
    // The winner is logged so a mis-resolved login browser is debuggable from
    // the service log alone. Before this existed, the log's only binary line
    // came from the SESSION path and was read as describing this launch.
    console.info(`[agentbrowser] login browser binary: ${executablePath} (${selection})`);
    // The lock is acquired LAST: every refusal above must leave the profile
    // unlocked, or a transient mistake (a wider mode, a moved binary, no
    // display) wedges it for the process lifetime.
    await this.acquireProfileLock();
    const startedAt = performance.now();
    try {
      this.context = await chromium.launchPersistentContext(this.options.profileDir, {
        headless,
        args,
        ignoreDefaultArgs: [...LOGIN_BROWSER_DISABLE_FLAGS],
        ...(executablePath !== undefined ? { executablePath } : {}),
        // Explicit, because Playwright's 30s default is demonstrably too
        // tight here: a launchd-started server was measured at 23s.
        timeout: this.launchTimeoutMs,
      });
    } catch (error) {
      await this.releaseProfileLock();
      throw error;
    }
    this.reportLaunchElapsed(performance.now() - startedAt);
    // The operator closing the last window marks the browser closed.
    //
    // Both effects are guarded by the IDENTITY of the context this handler was
    // registered for (review finding 4). `reapDeadContext` now calls close()
    // on a context Playwright already considers gone, and a wedged pipe — the
    // motivating case — can make that close resolve long afterwards. Without
    // the guard, a late 'close' for context A would null out a live context B
    // and delete B's lock, leaving the operator with an open window the server
    // reports as closed.
    const launched = this.context;
    const token = this.lockToken;
    launched.on('close', () => {
      if (this.context === launched) this.context = undefined;
      void this.releaseProfileLockIfToken(token);
    });
    // The launched context is the best source, the probe's reading is the
    // fallback, and an empty string counts as absent (round-5 review finding
    // 1, reproduced). Without the fallback, a path-change adoption whose
    // version read failed wrote a pin with NO comparable version — and the
    // next legitimate in-place Chrome update then hard-refused
    // LOGIN_BINARY_DOWNGRADED with profile-destroying reset() as the only
    // recovery, which is round-2 finding 1 reached from the other side.
    const reported = this.context.browser()?.version();
    const chromiumVersion = reported !== undefined && reported !== '' ? reported : probedVersion;
    // Carry every previous value forward and let this launch's readings
    // override them, rather than rebuilding the pin from what we happened to
    // read (round-3 review finding 6). A dropped field is not neutral: losing
    // `chromiumVersion` (an undefined `browser()?.version()`) would make the
    // next legitimate in-place update unadjudicable and hard-refuse
    // LOGIN_BINARY_DOWNGRADED with only reset() as recovery, and losing
    // size/mtime (a swallowed stat error) would skip the gate for a launch
    // and accept an unadjudicated replacement.
    //
    // A fresh adoption in pinUpdate lands last. When it records only a
    // version — a same-path update, where the path did not change — the stale
    // adoptedFromExecutable from an EARLIER path adoption is cleared, so the
    // audit record describes one event instead of splicing two together
    // (finding 7).
    const adoptionIsSamePath =
      pinUpdate.adoptedAtMs !== undefined && pinUpdate.adoptedFromExecutable === undefined;
    // Destructured out rather than assigned undefined: exactOptionalPropertyTypes
    // makes `{ adoptedFromExecutable: undefined }` a type error, and omitting
    // the key is what "clear it" actually means on disk anyway.
    const {
      adoptedFromExecutable: priorAdoptedFrom,
      executableSize: priorSize,
      executableModifiedMs: priorMtime,
      chromiumVersion: priorVersion,
      ...carried
    } = pin;
    // Identity and version describe a SPECIFIC binary, so they are carried
    // forward only while the path is unchanged (round-4 review finding 4).
    // Across a path change, carrying them would pin the new executable with
    // the old binary's bytes and version, and the next launch would then
    // adjudicate an in-place change against the wrong baseline — a spurious
    // LOGIN_BINARY_DOWNGRADED whose only recovery is profile-destroying
    // reset(), or an unadjudicated acceptance. Dropping is the safe direction
    // here, exactly where finding 6 said carrying was safe for the same path.
    const samePath = executablePath !== undefined && executablePath === pin.executable;
    await this.writePin({
      ...carried,
      ...(samePath && priorSize !== undefined ? { executableSize: priorSize } : {}),
      ...(samePath && priorMtime !== undefined ? { executableModifiedMs: priorMtime } : {}),
      ...(samePath && priorVersion !== undefined ? { chromiumVersion: priorVersion } : {}),
      ...(priorAdoptedFrom !== undefined && !adoptionIsSamePath
        ? { adoptedFromExecutable: priorAdoptedFrom }
        : {}),
      ...(executablePath !== undefined ? { executable: executablePath } : {}),
      ...(identity !== undefined
        ? { executableSize: identity.size, executableModifiedMs: identity.modifiedMs }
        : {}),
      ...(chromiumVersion !== undefined ? { chromiumVersion } : {}),
      ...pinUpdate,
      launches: (pin.launches ?? 0) + 1,
    });
  }

  /**
   * Drops a context whose browser is gone, so the next launch can proceed.
   * Separate from `isOpen` on purpose: a getter must not have side effects.
   */
  private reapDeadContext(): Promise<void> {
    const context = this.context;
    if (context === undefined) return Promise.resolve();
    // Only reap on POSITIVE evidence of disconnection — never on "cannot
    // tell". Reaping an unknown state would drop a live context, taking the
    // operator's window with it.
    if (contextDisconnected(context) !== true) return Promise.resolve();
    this.context = undefined;
    // Frees Playwright's own bookkeeping for a browser that is already gone.
    void context.close().catch(() => undefined);
    // AWAITED by callers (review finding 3): a fire-and-forget release let
    // close() resolve with the lock still on disk.
    return this.releaseProfileLockIfToken(this.lockToken);
  }

  async close(): Promise<void> {
    return this.serialize(() => this.closeLocked());
  }

  private async closeLocked(): Promise<void> {
    // A disconnected context closes SUCCESSFULLY rather than throwing, so the
    // reap (which releases the profile lock) actually runs for a wedged or
    // killed Chrome instead of the caller seeing LOGIN_BROWSER_CLOSED and
    // giving up. A context that was never open still throws — the lifecycle
    // test pins that — so only the dead-context case changes. The service's
    // closeForShutdown() calls this unconditionally for the same reason.
    if (this.context !== undefined && contextDisconnected(this.context) === true) {
      await this.reapDeadContext();
      return;
    }
    const context = this.context;
    if (context === undefined) {
      throw new LoginBrowserError('LOGIN_BROWSER_CLOSED', 'the login browser is closed');
    }
    this.closing = (async () => {
      this.context = undefined;
      await context.close();
      await this.releaseProfileLock();
    })();
    try {
      await this.closing;
    } finally {
      this.closing = undefined;
    }
  }

  /**
   * Reads the OPEN login browser's cookies with NO url filter, then filters
   * server-side: partitioned and expired cookies are skipped and counted.
   * There is no headless read; a closed browser refuses.
   */
  async readCookies(): Promise<ReadLoginCookiesResult> {
    return this.serialize(() => this.readCookiesLocked());
  }

  private async readCookiesLocked(): Promise<ReadLoginCookiesResult> {
    // Reap first, so a wedged browser refuses with LOGIN_BROWSER_CLOSED
    // instead of hanging in context.cookies().
    await this.reapDeadContext();
    const context = this.context;
    if (context === undefined) {
      throw new LoginBrowserError('LOGIN_BROWSER_CLOSED', 'the login browser is closed');
    }
    const now = this.options.now?.() ?? Date.now();
    const all = await context.cookies();
    const cookies: LoginCookie[] = [];
    let partitioned = 0;
    let expired = 0;
    for (const cookie of all) {
      const keyed = (cookie as { partitionKey?: unknown }).partitionKey !== undefined;
      const opaque = (cookie as { partitionKeyOpaque?: unknown }).partitionKeyOpaque !== undefined;
      if (keyed || opaque) {
        partitioned += 1;
        continue;
      }
      // Playwright expires is unix SECONDS; the clock is ms.
      if (cookie.expires !== -1 && cookie.expires * 1000 <= now) {
        expired += 1;
        continue;
      }
      cookies.push({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      });
    }
    return { cookies, skipped: { partitioned, expired } };
  }

  /** Deletes the profile directory (after close). */
  async reset(): Promise<void> {
    return this.serialize(async () => {
      // Without the reap, a dead context would refuse "close it first"
      // forever — wedging the one recovery the operator has.
      await this.reapDeadContext();
      if (this.context !== undefined) {
        throw new LoginBrowserError(
          'LOGIN_BROWSER_CLOSED',
          'close the login browser before resetting its profile'
        );
      }
      await rm(this.options.profileDir, { recursive: true, force: true });
    });
  }

  // --- profile security ---------------------------------------------------

  private async assertProfileSecure(): Promise<void> {
    if (!existsSync(this.options.profileDir)) {
      if (process.platform === 'win32') {
        await createOwnerOnlyDirectory(this.options.profileDir);
      } else {
        // chmod is applied by mkdir's mode; umask could have widened it.
        await mkdir(this.options.profileDir, { recursive: true, mode: 0o700 });
        const mode = statSync(this.options.profileDir).mode & 0o777;
        if (mode !== 0o700) {
          await rm(this.options.profileDir, { recursive: true, force: true });
          throw new LoginBrowserError(
            'LOGIN_PROFILE_MODE',
            `the login profile directory must be readable by its owner only (found mode ${mode.toString(8)})`
          );
        }
      }
      return;
    }
    if (process.platform === 'win32') {
      await assertWindowsDaclOwnerOnly(this.options.profileDir);
    } else {
      const mode = statSync(this.options.profileDir).mode & 0o777;
      if (mode !== 0o700) {
        throw new LoginBrowserError(
          'LOGIN_PROFILE_MODE',
          `the login profile directory must be readable by its owner only (found mode ${mode.toString(8)})`
        );
      }
    }
  }

  // --- binary pin ----------------------------------------------------------

  private pinPath(): string {
    return join(this.options.profileDir, 'agentbrowser-pin.json');
  }

  private async readPin(): Promise<ProfilePin> {
    try {
      return JSON.parse(await readFile(this.pinPath(), 'utf8')) as ProfilePin;
    } catch {
      return { launches: 0 };
    }
  }

  private async writePin(pin: ProfilePin): Promise<void> {
    await mkdir(this.options.profileDir, { recursive: true });
    await writeFile(this.pinPath(), `${JSON.stringify(pin, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * ADR-025 §1: "The login browser always launches the same executablePath,
   * resolved once at enablement (ADR-016's branded-Chrome selection, or
   * AGENTBROWSER_CHROME_PATH), and refuses if that binary's version has moved
   * backwards."
   *
   * Until now this called `chromium.executablePath()` unconditionally and so
   * always ran Playwright's bundled Chrome for Testing — never the operator's
   * branded Chrome, which is what a real login wall is likeliest to accept.
   *
   * Unlike the engine (which omits `executablePath` for the bundled case),
   * this always returns a CONCRETE path so the pin names a real file.
   */
  private async resolvePinnedExecutable(pin: ProfilePin): Promise<{
    path: string | undefined;
    identity: ExecutableIdentity | undefined;
    pinUpdate: Partial<ProfilePin>;
    probedVersion?: string;
    selection: string;
  }> {
    const branded = await resolveBrandedChrome(this.chromePreference);
    const selection = branded.selection;
    const resolved = branded.path ?? chromium.executablePath();
    if (resolved === undefined) {
      return { path: undefined, identity: undefined, pinUpdate: {}, selection };
    }
    const identity = await executableIdentity(resolved);
    // First launch pins the binary; later launches must match it exactly.
    if (pin.executable === undefined) return { path: resolved, identity, pinUpdate: {}, selection };

    if (pin.executable !== resolved) {
      // A path change we can explain as OUR OWN doing is adopted once rather
      // than refused: the profile (the operator's logins — the whole asset
      // this browser exists to hold) survives, and `reset()` stays reserved
      // for mismatches we cannot account for. Two cases qualify, both
      // server-controlled: the pre-fix bundled pin being replaced by branded
      // resolution, and a Playwright dependency bump moving the
      // chromium-<rev> path (which refuses today, with reset() as the only
      // exit). Every other path change still refuses.
      // Review finding 1: adoption must STILL honor "never opened by an older
      // binary". Playwright often bundles a Chrome for Testing from a FUTURE
      // milestone, so the operator's branded stable Chrome can be OLDER than
      // the bundled build this pin names — and the bundled→branded migration
      // is the path every existing deployment takes exactly once. Adopting it
      // unchecked would hand a profile written by the newer build to the older
      // one, which is the loss ADR-025 §1 forbids, and would then rewrite the
      // pin to the lower version, erasing the evidence.
      // EITHER side looking Playwright-managed makes this our own resolution
      // changing rather than the operator pointing at something new.
      //
      // Checking only the pin (round-3 review finding 2) made adoption
      // one-directional, and the docs this PR adds prescribe the other
      // direction: "set AGENTBROWSER_PREFER_BUNDLED=1" for a faster open would
      // have refused LOGIN_BINARY_CHANGED once the pin named branded Chrome,
      // leaving profile-destroying reset() as the only recovery — following
      // our own documentation would have cost the operator their logins. It
      // also covers macOS swapping the whole Chrome .app during a self-update:
      // resolution briefly finds no branded binary, falls back to bundled, and
      // that must not brick the profile either. Still fully subject to the
      // downgrade gate below.
      if (looksLikePlaywrightBundled(pin.executable) || looksLikePlaywrightBundled(resolved)) {
        const outcome = await this.assertNotADowngrade({
          pin,
          resolved,
          adoptMessage: `adopting a new binary (one side is a Playwright-managed build, so this is our own resolution changing)\n  was: ${pin.executable}\n  now: ${resolved}`,
          // The version-less escape stays NARROW: only a pin that itself names
          // a Playwright build gets it. That is the legacy case it was added
          // for — pins written before chromiumVersion was recorded, all of
          // which name the bundled binary. Widening adoption to either side
          // (round 3) dragged the escape along with it, so branded→bundled on
          // a version-less pin would have adopted with no probe and no
          // comparison at all (round-4 review finding 3).
          adoptWhenPinHasNoVersion: looksLikePlaywrightBundled(pin.executable),
        });
        return {
          path: resolved,
          identity,
          pinUpdate: {
            adoptedFromExecutable: pin.executable,
            adoptedAtMs: Date.now(),
            ...outcome.pin,
          },
          ...(outcome.probedVersion !== undefined ? { probedVersion: outcome.probedVersion } : {}),
          selection,
        };
      }
      throw new LoginBrowserError(
        'LOGIN_BINARY_CHANGED',
        'the pinned browser binary changed since this profile was created; reset the profile to adopt the new binary'
      );
    }

    // Same path, different bytes: the binary was replaced in place, which is
    // how Chrome self-updates. ADR-025's rule is "moved BACKWARDS", and its
    // stated reason is Chrome's DOWNGRADE handling moving a profile aside —
    // so a forward update must be adopted, not refused. Refusing every
    // in-place change (the previous behavior) was stricter than the ADR and
    // harmless only while the binary was Playwright's frozen build; against a
    // self-updating branded Chrome it would refuse after every update, with
    // profile-destroying reset() as the only recovery.
    if (
      pin.executableSize !== undefined &&
      identity !== undefined &&
      (identity.size !== pin.executableSize || identity.modifiedMs !== pin.executableModifiedMs)
    ) {
      const outcome = await this.adjudicateInPlaceReplacement(pin, resolved, identity);
      return {
        path: resolved,
        identity,
        pinUpdate: outcome.pin,
        ...(outcome.probedVersion !== undefined ? { probedVersion: outcome.probedVersion } : {}),
        selection,
      };
    }
    return { path: resolved, identity, pinUpdate: {}, selection };
  }

  /**
   * Decide whether a same-path, different-bytes binary may open the profile,
   * by comparing its version against the pin — WITHOUT letting it near the
   * login profile.
   *
   * The version comes from a `chromium.launch()` probe, which uses a
   * Playwright-managed throwaway profile directory. `launchPersistentContext`
   * must not be used to answer this: Chrome processes its downgrade handling
   * when it OPENS a profile (ADR-025 §1: "Chrome's downgrade handling can move
   * a profile aside and lose the logins"), so a verdict reached after that
   * launch would come too late — and an untrusted binary would already have
   * held the profile path as --user-data-dir, against a cookie DB ADR-025 §2
   * calls equivalent to plaintext. A later close() would be a flush, not a
   * rollback.
   *
   * No subprocess is involved, so this works on Windows, where the original
   * `chrome.exe --version` probe printed nothing (the reason the pin compared
   * file identity instead).
   */
  private async adjudicateInPlaceReplacement(
    pin: ProfilePin,
    resolved: string,
    identity: ExecutableIdentity
  ): Promise<AdoptionOutcome> {
    return this.assertNotADowngrade({
      pin,
      resolved,
      failureContext: `the browser binary at the pinned path was replaced in place (recorded ${pin.executableSize} bytes, now ${identity.size})`,
      // An ABSENT pinned version is adoptable here too (round-6 finding 1).
      // It cannot be evidence of a downgrade — nothing was recorded to move
      // backwards from — and it is reachable without any legacy pin at all: a
      // first launch whose version() read failed writes a version-less pin,
      // and the next ordinary Chrome update would then hard-refuse with
      // reset() as the only way out. A PRESENT-but-unparseable version still
      // fails closed inside assertNotADowngrade, which is the tamper-shaped
      // case this flag used to be guarding.
      adoptWhenPinHasNoVersion: true,
      onEqual: (order) => {
        // Same version, different bytes is not a Chrome update; it is the
        // signature of a replaced binary. Refuse under the path-change code.
        if (order === 0) {
          throw new LoginBrowserError(
            'LOGIN_BINARY_CHANGED',
            `the binary at the pinned path was replaced with different bytes reporting the SAME version (${pin.chromiumVersion}); reset the profile to adopt it`
          );
        }
      },
    });
  }

  /**
   * The shared "never opened by an older binary" gate (ADR-025 §1), used by
   * BOTH adoption paths — the bundled→branded / dependency-bump path change
   * and the same-path in-place replacement. Returns the pin fields recording
   * what was superseded, or throws.
   *
   * `onEqual` lets the same-path caller treat an identical version as tamper;
   * for a path change an equal version is a perfectly ordinary adoption.
   *
   * `adoptWhenPinHasNoVersion` differs by caller on purpose (round-2 review
   * finding 1). `chromiumVersion` is optional — pins written before it was
   * recorded, or by a launch whose `browser()` yielded nothing, have none. For
   * a SAME-PATH swap that is suspicious, so it fails closed. For a PATH change
   * we can already explain as our own, refusing would be strictly worse than
   * the behavior it replaced: that case used to adopt, so failing closed would
   * force the profile-destroying `reset()` and lose exactly the logins this
   * gate exists to protect. With no pinned version there is no downgrade to
   * prove, and Chrome's own `Last Version` check remains the backstop.
   */
  private async assertNotADowngrade(options: {
    pin: ProfilePin;
    resolved: string;
    adoptMessage?: string;
    failureContext?: string;
    adoptWhenPinHasNoVersion: boolean;
    onEqual?: (order: number) => void;
  }): Promise<AdoptionOutcome> {
    const { pin, resolved, adoptMessage, onEqual } = options;
    const failureContext =
      options.failureContext ?? 'the resolved browser binary differs from the pinned one';
    // Annotated `never` so the compiler knows these calls terminate — without
    // it the narrowed types below would need casts.
    const refuse: (reason: string) => never = (reason) => {
      throw new LoginBrowserError(
        'LOGIN_BINARY_DOWNGRADED',
        `${failureContext}: ${reason}; reset the profile to adopt it`
      );
    };
    const announce = (superseded: string, probedText: string): void => {
      console.info(
        `[agentbrowser] login profile: ${adoptMessage ?? `adopting an in-place browser update (${superseded} -> ${probedText})`}`
      );
    };
    const pinned = parseChromeVersion(pin.chromiumVersion);
    if (pinned === undefined) {
      // ABSENT and UNPARSEABLE are different things, and conflating them is
      // the structural root cause behind rounds 2, 5 and 6 (round-6 review
      // finding 1, reproduced on two further paths including a plain first
      // launch whose version read failed).
      //
      // `chromiumVersion` is only ever recorded from sources that can fail —
      // the launched context's version(), or the probe. So its ABSENCE is
      // evidence of OUR recording gap, not of tampering, and refusing on it
      // punishes the operator with profile-destroying reset() for something
      // we failed to write. A value that is PRESENT but not parseable is the
      // opposite: something put a non-version string there, which is
      // tamper-shaped and must still fail closed.
      if (pin.chromiumVersion !== undefined) {
        refuse(`the pinned version ${JSON.stringify(pin.chromiumVersion)} is not comparable`);
      }
      if (!options.adoptWhenPinHasNoVersion) {
        refuse('the pinned version is missing');
      }
      // NO probe here (round-3 review finding 4). There is nothing to compare
      // against, so a probe could only decorate the log line — and it would
      // cost a second full Chrome launch on the one-time migration, the very
      // path most likely to be slow. The absence is not load-bearing any
      // more: an absent version is adoptable above rather than a refusal
      // waiting to happen on the next in-place update.
      announce(pin.chromiumVersion ?? '(unrecorded)', '(not comparable)');
      // Preserve whatever string WAS recorded, even if unparseable; only a
      // genuinely absent version reads as unrecorded.
      return {
        pin: {
          adoptedFromVersion: pin.chromiumVersion ?? '(unrecorded)',
          adoptedAtMs: Date.now(),
        },
      };
    }
    const probedRaw = await probeChromeVersion(resolved, this.launchTimeoutMs);
    const probed = parseChromeVersion(probedRaw);
    if (probed === undefined) refuse('the candidate binary did not report a comparable version');
    const order = compareChromeVersion(probed, pinned);
    if (order < 0) {
      refuse(
        `the candidate is OLDER (pinned ${pin.chromiumVersion}, found ${probed.join('.')}) — a profile is never opened by an older binary than the one that last wrote it`
      );
    }
    onEqual?.(order);
    announce(pin.chromiumVersion ?? '(unrecorded)', probed.join('.'));
    // The superseded VERSION is the useful record for a same-path update (the
    // path is unchanged, so recording it says nothing — round-1 finding 7).
    // `probedVersion` is handed back so openLocked can fall back to it if the
    // launched context cannot report one (round-5 review finding 1): we paid
    // for this reading already, and without it a path-change adoption could
    // leave the pin with no comparable version at all.
    return {
      pin: { adoptedFromVersion: pin.chromiumVersion ?? '(unrecorded)', adoptedAtMs: Date.now() },
      ...(probedRaw !== undefined && probedRaw !== '' ? { probedVersion: probedRaw } : {}),
    };
  }

  // --- profile lock --------------------------------------------------------

  private lockPath(): string {
    return join(this.options.profileDir, 'agentbrowser-lock');
  }

  /**
   * The token written into the lock for the CURRENT launch: `<pid>:<nonce>`.
   *
   * The pid alone cannot distinguish this process's own next lock from the one
   * a late handler is trying to release (review finding 5) — the operator
   * closing and immediately reopening gives both the same pid, so a stale
   * handler could delete the new lock and let another process in while our
   * Chrome owns the profile. The stale-adoption logic only reads the pid
   * prefix, so the nonce costs it nothing.
   */
  private lockToken = '';

  private async acquireProfileLock(): Promise<void> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const mine = `${process.pid}:${randomUUID()}`;
        await writeFile(this.lockPath(), mine, { flag: 'wx', mode: 0o600 });
        this.lockToken = mine;
        return;
      } catch (error) {
        const holder = await readFile(this.lockPath(), 'utf8').catch(() => undefined);
        const holderPid = holder !== undefined ? Number.parseInt(holder, 10) : Number.NaN;
        if (!Number.isNaN(holderPid) && !processExists(holderPid)) {
          // Stale lock: adopt it.
          await rm(this.lockPath(), { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new LoginBrowserError(
            'LOGIN_PROFILE_IN_USE',
            'the login profile is in use by another process'
          );
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
        void error;
      }
    }
  }

  private async releaseProfileLock(): Promise<void> {
    await rm(this.lockPath(), { force: true });
  }

  /**
   * Release the lock only if it is still the one `token` acquired. The 'close'
   * handler and the reap can both fire late — after this or another instance
   * has acquired a NEW lock — and an unconditional rm would delete it.
   */
  private async releaseProfileLockIfToken(token: string): Promise<void> {
    if (token === '') return;
    const holder = await readFile(this.lockPath(), 'utf8').catch(() => undefined);
    if (holder !== undefined && holder.trim() !== token) return;
    if (this.lockToken === token) this.lockToken = '';
    await this.releaseProfileLock();
  }

  /**
   * Chrome's OWN profile lock (ProcessSingleton), which is separate from
   * agentbrowser-lock: <profile>/SingletonLock is a symlink whose target is
   * `<hostname>-<pid>`.
   *
   * We only ever READ it. Removing it is unsafe in exactly the case that
   * motivates looking: a wedged-but-ALIVE Chrome. Deleting its lock would let
   * a second Chrome open the same Cookies DB and Local State and lose the
   * logins. It is also POSIX-only (Windows Chrome uses a named mutex plus
   * <profile>\lockfile), so deleting would no-op on the platform where
   * App-Bound Encryption raises the stakes most. And ADR-025 §1 already notes
   * a same-host stale lock "is taken over by Chrome on the same host", so
   * there is nothing to gain where deletion would be safe.
   *
   * What this adds is a typed refusal instead of a Chrome that exits
   * instantly: a live or foreign-host owner becomes LOGIN_PROFILE_IN_USE,
   * refused BEFORE agentbrowser-lock is acquired, naming the recovery.
   */
  private async assertChromeSingletonFree(): Promise<void> {
    const inspect = (): ReturnType<typeof inspectChromeSingleton> =>
      inspectChromeSingleton(
        this.options.profileDir,
        this.options.isBrowserPid ?? processLooksLikeBrowser
      );
    let state = await inspect();
    // A live owner gets a grace period before it is called a conflict
    // (round-3 review finding 3). When the operator closes the last window,
    // Playwright reports the context closed while the Chrome process is still
    // exiting and flushing Cookies/Local State, so its SingletonLock briefly
    // still names a live browser pid. Refusing on the first read turned an
    // ordinary close-then-reopen into LOGIN_PROFILE_IN_USE advising the
    // operator to kill Chrome and delete Singleton* — destructive advice for a
    // state that clears itself in about a second. acquireProfileLock() already
    // polls the same window for exactly this class of transient.
    // A non-live reading must be CONFIRMED before we act on it (round-4
    // review finding 2). `inspectChromeSingleton` reports `stale` whenever
    // processName() returns undefined, and on darwin that is an
    // `execFile('ps')` which can fail transiently under load. Sampling once
    // gave that one chance to mislead; polling every 50ms gave it ~100, and
    // the first false negative won — we would then take the lock and launch
    // against a profile a live Chrome still owns, so Chrome's own
    // ProcessSingleton makes the new instance defer and the operator gets an
    // opaque Playwright timeout (now after the full launch budget) instead of
    // the typed refusal this check exists to produce.
    // LOCK_TIMEOUT_MS bounds how long we keep RETRYING, not the wall time:
    // the deadline is checked between operations, and each inspect() on a
    // live-pid path may run `ps` with its own 5s timeout, so a pathological
    // case can take ~15s before the typed refusal (round-5 review finding 2).
    // That only happens while confirming a real conflict, where a correct
    // refusal matters more than a fast one.
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      if (state.state !== 'live') {
        // Second opinion before acting on "not live".
        const confirmed = await inspect();
        state = confirmed;
        if (confirmed.state !== 'live') break;
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      state = await inspect();
    }
    if (state.state === 'live') {
      throw new LoginBrowserError(
        'LOGIN_PROFILE_IN_USE',
        `another Chrome (pid ${state.pid}) holds this login profile; close it, then open the login browser again. If no such window exists, that Chrome has wedged — kill the process, then remove SingletonLock, SingletonSocket and SingletonCookie from the profile directory`
      );
    }
    if (state.state === 'foreign-host') {
      throw new LoginBrowserError(
        'LOGIN_PROFILE_IN_USE',
        `this login profile is locked by Chrome on a different host (${state.host}; this host is ${hostname()}). Chrome only breaks a stale lock from the same host — remove SingletonLock, SingletonSocket and SingletonCookie from the profile directory once no Chrome is using it`
      );
    }
  }
}

/**
 * Classify Chrome's ProcessSingleton lock without modifying anything.
 *
 * `isBrowserPid` is a test seam: the real predicate reads the process name,
 * which a unit test cannot arrange for a pid it does not own.
 */
export async function inspectChromeSingleton(
  profileDir: string,
  isBrowserPid: (pid: number) => Promise<boolean> = processLooksLikeBrowser
): Promise<
  | { state: 'absent' }
  | { state: 'stale' }
  | { state: 'live'; pid: number }
  | { state: 'foreign-host'; host: string }
  | { state: 'unreadable' }
> {
  const target = await readlink(join(profileDir, 'SingletonLock')).catch(() => undefined);
  if (target === undefined) return { state: 'absent' };
  // `<hostname>-<pid>`; the hostname itself may contain dashes, so split at
  // the LAST one.
  const split = target.lastIndexOf('-');
  if (split <= 0) return { state: 'unreadable' };
  const host = target.slice(0, split);
  const pid = Number.parseInt(target.slice(split + 1), 10);
  if (Number.isNaN(pid)) return { state: 'unreadable' };
  if (host !== hostname()) return { state: 'foreign-host', host };
  // Same host: only a live owner that is actually a BROWSER is refused.
  //
  // Review finding 2: pid existence alone is not enough. A crashed Chrome
  // leaves the lock holding a dead pid, pids recycle quickly (Linux pid_max
  // defaults to 32768, and after a reboot the low pids all belong to
  // daemons), and processExists() also answers true on EPERM for a pid owned
  // by another user. Trusting it would let an unrelated process permanently
  // refuse LOGIN_PROFILE_IN_USE, naming a recovery the operator cannot
  // perform and leaving profile-destroying reset() as the only exit — a
  // regression against the previous behavior, where Chrome simply broke the
  // stale lock. So an unverifiable or non-browser owner is reported stale and
  // left to Chrome's own ProcessSingleton, which does not trust the pid
  // either (it tries SingletonSocket).
  if (!processExists(pid)) return { state: 'stale' };
  return (await isBrowserPid(pid)) ? { state: 'live', pid } : { state: 'stale' };
}

/**
 * Does this pid belong to a browser? Best-effort and deliberately
 * conservative: anything we cannot read is NOT treated as a browser, so the
 * caller falls back to letting Chrome arbitrate rather than locking the
 * operator out.
 */
async function processLooksLikeBrowser(pid: number): Promise<boolean> {
  const name = await processName(pid);
  if (name === undefined) return false;
  return /chrom(e|ium)/i.test(name);
}

async function processName(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    // /proc/<pid>/exe is the authoritative path; comm is truncated to 15
    // chars ("Google Chrome f"), which still matches the pattern above.
    const { readlink: rl, readFile: rf } = await import('node:fs/promises');
    const exe = await rl(`/proc/${pid}/exe`).catch(() => undefined);
    if (exe !== undefined) return exe;
    return (await rf(`/proc/${pid}/comm`, 'utf8').catch(() => undefined))?.trim();
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  return await promisify(execFile)('ps', ['-o', 'comm=', '-p', `${pid}`], { timeout: 5_000 })
    .then(({ stdout }) => stdout.trim() || undefined)
    .catch(() => undefined);
}

/**
 * The version a candidate binary reports, read over Playwright's pipe with a
 * THROWAWAY profile — `launch()`, never `launchPersistentContext()`, so the
 * login profile is never opened by a binary that has not been vetted yet.
 */
async function probeChromeVersion(
  executablePath: string,
  timeoutMs: number
): Promise<string | undefined> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    // The SAME budget as the real launch, not a stricter inline one. This
    // probe is a launch of the same binary in the same environment, and it
    // FAILS CLOSED: a probe that merely ran out of time yields
    // LOGIN_BINARY_DOWNGRADED, which tells the operator to reset() and
    // destroys the logins the gate exists to protect. It also runs on the
    // one-time bundled->branded migration, i.e. the launch most likely to be
    // slow under launchd — exactly the wrong place for a tight budget.
    browser = await chromium.launch({ headless: true, executablePath, timeout: timeoutMs });
    return browser.version();
  } catch {
    return undefined;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/**
 * Does this path look like a Playwright-managed browser build? Used only to
 * decide whether a path change is one WE caused (a dependency bump, or the
 * pre-ADR-016 bundled pin) and may therefore be adopted without destroying
 * the profile. A false negative only costs the operator a `reset`, so the
 * heuristic is deliberately loose.
 */
export function looksLikePlaywrightBundled(path: string): boolean {
  if (path === chromium.executablePath()) return true;
  // Playwright's own layout, wherever PLAYWRIGHT_BROWSERS_PATH points it:
  // `<root>/chromium-<rev>/...` or a path under an `ms-playwright` cache dir.
  //
  // Deliberately NOT a bare `path.startsWith(PLAYWRIGHT_BROWSERS_PATH)`
  // (round-4 review finding 3): that env var is operator-settable, the prefix
  // test had no separator boundary (root `/opt/pw` matched `/opt/pwned/chrome`),
  // and setting it to `/Applications` or `/` would have made the
  // LOGIN_BINARY_CHANGED branch unreachable. The shape check covers every real
  // Playwright install under any root without trusting the variable.
  // `chromium[a-z_]*` so real Playwright directory names other than
  // `chromium-<rev>` match too — notably `chromium_headless_shell-<rev>`,
  // which the previous pattern missed because it required digits immediately
  // after the optional separator (round-5 review finding 4). Latent rather
  // than live, since executablePath() returns the headed path, but the env
  // check that used to cover it is gone.
  // NARROWED to exactly Playwright's two directory shapes, with a REQUIRED
  // separator before the revision (round-6 review finding 2). The previous
  // `chromium[a-z_]*[_-]?\d+` also matched operator-built trees like
  // `/opt/chromium_build_42/chrome` and `/home/u/chromiumfoo123/chrome`.
  // Looseness here used to be harmless — a false negative merely cost the
  // operator a `reset` — but now a false POSITIVE adopts a path change that
  // should refuse, so the safe direction has flipped.
  return (
    /[/\\]chromium(?:_headless_shell)?[_-]\d+[/\\]/i.test(path) ||
    /[/\\]ms-playwright[/\\]/.test(path)
  );
}

/**
 * What an adoption decision yields: the pin fields it records, plus the
 * version the probe read (kept OUT of the pin fields so it cannot be written
 * as a pin key — it is a fallback for `chromiumVersion`, not a field).
 */
interface AdoptionOutcome {
  pin: Partial<ProfilePin>;
  probedVersion?: string;
}

interface ExecutableIdentity {
  size: number;
  modifiedMs: number;
}

/**
 * The executable's file identity: any in-place replacement (an update)
 * changes the size, the mtime, or both. fs.stat only — no subprocess, so it
 * works identically on Windows, where a `--version` probe cannot see
 * anything (chrome.exe, a GUI-subsystem exe, prints no stdout there).
 */
async function executableIdentity(path: string): Promise<ExecutableIdentity | undefined> {
  try {
    const info = await stat(path);
    return { size: info.size, modifiedMs: info.mtimeMs };
  } catch {
    return undefined; // never block a launch on the identity read
  }
}

/**
 * Is this context's browser positively disconnected?
 *
 * `true` = gone (reap it). `false` = alive. `undefined` = cannot tell, which
 * callers treat as alive: a persistent context always exposes `browser()` in
 * production (the pin's chromiumVersion is read through it), so the
 * undeterminable case is a test stub, and guessing "dead" there would drop a
 * live context.
 */
function contextDisconnected(context: BrowserContext): boolean | undefined {
  if (typeof context.browser !== 'function') return undefined;
  const browser = context.browser();
  if (browser === null || browser === undefined) return undefined;
  if (typeof browser.isConnected !== 'function') return undefined;
  return !browser.isConnected();
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The socket inodes the pid holds fds for (readlink: reading the fd symlink as a file fails). */
async function ownedSocketInodes(pid: number): Promise<Set<string>> {
  const owned = new Set<string>();
  const { readdir, readlink } = await import('node:fs/promises');
  for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])) {
    const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
    const match = /socket:\[(\d+)\]/.exec(target);
    if (match?.[1] !== undefined) owned.add(match[1]);
  }
  return owned;
}

function displayAvailable(): boolean {
  if (process.platform === 'win32') return true;
  if (process.platform === 'darwin') return true;
  return typeof process.env.DISPLAY === 'string' && process.env.DISPLAY !== '';
}

// --- Windows DACL (executed by the Windows CI job, which runs this suite) -

/**
 * Profile security on Windows (ADR-025 section 1), via icacls — always
 * present, no PowerShell module system to fail on a runner:
 * - Creation: mkdir, then strip inheritance and grant the owner's SID alone
 *   (OI)(CI)F, so every file Chrome creates inherits owner-only access.
 * - Verification: parse `icacls <dir>` ACE lines by SID; any ACE beyond the
 *   owner (minus SYSTEM and Administrators, which are reported, not refused)
 *   refuses with LOGIN_PROFILE_MODE.
 */
async function createOwnerOnlyDirectory(dir: string): Promise<void> {
  // Create first (inheriting), then immediately strip inheritance and grant
  // the owner alone. The create-then-protect window is inherent to process
  // creation and holds no profile data; assertWindowsDaclOwnerOnly refuses
  // anything left wider on the next open (the ADR's "atomically" is this
  // ordering, not a single syscall).
  await mkdir(dir, { recursive: true });
  const sid = (await currentUserIdentity()).sid;
  await runIcacls(dir, ['/inheritance:r', '/grant', `*${sid}:(OI)(CI)F`]);
}

async function assertWindowsDaclOwnerOnly(dir: string): Promise<void> {
  const output = await runIcacls(dir, []);
  // icacls DISPLAYS translated names (NT AUTHORITY\SYSTEM, MACHINE\user)
  // while whoami yields the SID — exempt every spelling of the owner and of
  // the well-known pair (runner-proven: a name never equals a SID string).
  const me = await currentUserIdentity();
  const ownerForms = new Set(
    [
      me.sid,
      me.name,
      'NT AUTHORITY\\SYSTEM',
      'BUILTIN\\ADMINISTRATORS',
      'S-1-5-18',
      'S-1-5-32-544',
    ].map((form) => form.toLowerCase())
  );
  const foreign: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    // When icacls writes to a pipe, the filename header and the FIRST ACE
    // land on one space-separated line: `<dir> NT AUTHORITY\SYSTEM:(OI)(CI)(F)`.
    // Strip the echoed directory prefix first, or the first ACE is always foreign.
    let line = raw;
    const prefix = dir.toLowerCase();
    if (line.toLowerCase().startsWith(prefix)) line = line.slice(dir.length).trimStart();
    // ACE lines look like `S-1-5-21-...:(OI)(CI)F` or `NT AUTHORITY\SYSTEM:(OI)(CI)F`;
    // summary lines ("Successfully processed 1 files") have no parenthesized rights.
    const ace = /^(.+?):(?:\([^)]*\))+(?:[FRODWS]+)?\s*$/.exec(line);
    if (ace?.[1] === undefined) continue;
    const identity = ace[1].trim();
    if (ownerForms.has(identity.toLowerCase())) continue;
    foreign.push(identity);
  }
  if (foreign.length > 0) {
    throw new LoginBrowserError(
      'LOGIN_PROFILE_MODE',
      `the login profile directory's ACL grants access beyond its owner: ${foreign.join(', ')}`
    );
  }
}

/**
 * The current user's identity via whoami /user (always present, no modules):
 * the SID and the MACHINE\user name icacls may display instead of it.
 */
async function currentUserIdentity(): Promise<{ sid: string; name: string; bare: string }> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)('whoami', ['/user', '/fo', 'csv'], {
    timeout: 10_000,
  });
  const row = stdout.split(/\r?\n/)[1];
  const cells = (row ?? '').split(',').map((cell) => cell.replace(/^"|"$/g, ''));
  const sid = cells[cells.length - 1];
  const name = cells[0] ?? '';
  if (sid === undefined || !sid.startsWith('S-1-') || name === '') {
    throw new LoginBrowserError(
      'LOGIN_PROFILE_MODE',
      'could not determine the current user identity'
    );
  }
  // whoami reports MACHINE\user. (No bare-user exemption: it would
  // false-exempt OTHERDOMAIN\sameuser.)
  return { sid, name, bare: name.split('\\')[1] ?? name };
}

export async function runIcacls(dir: string, args: string[]): Promise<string> {
  const { spawn } = await import('node:child_process');
  const system32 = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'icacls.exe')
    : 'icacls';
  return new Promise((resolve, reject) => {
    const child = spawn(system32, [dir, ...args], { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      // The full stderr: icacls diagnostics are fixed text and the only
      // variable is the path, which the operator chose.
      else reject(new Error(`icacls failed (${code}): ${err}`));
    });
  });
}

/**
 * Test hook: the set of chromium TCP listeners for a PID, via /proc on Linux.
 * Empty means no debugging port — the pipe launch guarantee.
 */
export async function tcpListenersOf(pid: number): Promise<number[]> {
  if (process.platform !== 'linux') return [];
  // The pid's own listening sockets: /proc/net/tcp[6] lists the namespace
  // (every host listener), so match each LISTEN inode against the pid's fds.
  const owned = await ownedSocketInodes(pid);
  const ports = new Set<number>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      const local = cols[1];
      const state = cols[3];
      const inode = cols[9];
      if (local === undefined || state !== '0A' || inode === undefined) continue;
      if (!owned.has(inode)) continue;
      const port = Number.parseInt(local.split(':')[1] ?? '0', 16);
      if (port !== 0) ports.add(port);
    }
  }
  return [...ports];
}
