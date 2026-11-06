// The plain-English steps shown before any wallet prompt (spec 7.2 step 4, todo 35 "Safety rules"). On by default:
// a caller can supply its own screen (presentSteps or the wallet's confirm), and can turn it off only by passing
// presentSteps: false. The default is the browser's confirm dialog when there is a page, and a block of text on
// stderr for a program (a CLI, an agent host), written before the first wallet prompt.

/** Shows the lines and answers true to go on to the wallet, false to stop before any prompt. */
export type StepPresenter = (lines: string[]) => Promise<boolean>;

export const STEPS_HEADING = "Before your wallet asks you to sign, here is what each step does:";

/** The text the default presenter shows: a heading, then one numbered line per step. */
export function stepsText(lines: string[]): string {
  return [STEPS_HEADING, ...lines.map((l, i) => `${i + 1}. ${l}`)].join("\n");
}

interface PageLike {
  confirm(message?: string): boolean;
}

function pageOf(g: typeof globalThis): PageLike | null {
  const w = (g as { window?: unknown }).window as Partial<PageLike> | undefined;
  const hasDocument = typeof (g as { document?: unknown }).document === "object";
  return w && hasDocument && typeof w.confirm === "function" ? (w as PageLike) : null;
}

/**
 * The default presenter. In a browser page: window.confirm with the steps (Cancel stops before any prompt). Anywhere
 * else: the steps are written to stderr (or console.log when there is no stderr) and the flow goes on, because a
 * program's wallet is the program's own account and there is no one to ask.
 */
export function defaultStepPresenter(g: typeof globalThis = globalThis): StepPresenter {
  return async (lines) => {
    const text = stepsText(lines);
    const page = pageOf(g);
    if (page) return page.confirm(text) === true;
    const stderr = (g as { process?: { stderr?: { write?: (s: string) => unknown } } }).process?.stderr;
    if (stderr && typeof stderr.write === "function") stderr.write(`[capstan] ${text}\n`);
    else console.log(`[capstan] ${text}`);
    return true;
  };
}

/** Which presenter a client uses: presentSteps, then the wallet's own confirm, then the default. false = none. */
export function resolvePresenter(presentSteps: StepPresenter | false | undefined, walletConfirm: StepPresenter | undefined, g: typeof globalThis = globalThis): StepPresenter | null {
  if (presentSteps === false) return null;
  if (typeof presentSteps === "function") return presentSteps;
  if (walletConfirm) return walletConfirm;
  return defaultStepPresenter(g);
}
