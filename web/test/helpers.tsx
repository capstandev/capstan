// Test helpers: mount a page in happy-dom with a config and a router, wait for text, type into fields.
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { ConfigContext, configFromEnv, type AppConfig } from "../src/config";

export interface Mounted {
  host: HTMLElement;
  text(): string;
  unmount(): Promise<void>;
}

export async function mount(el: ReactNode, o: { path?: string; config?: Partial<AppConfig>; layout?: boolean } = {}): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const cfg: AppConfig = { ...configFromEnv({}), ...(o.config ?? {}) };
  await act(async () => {
    root.render(
      <ConfigContext.Provider value={cfg}>
        <MemoryRouter initialEntries={[o.path ?? "/"]}>{el}</MemoryRouter>
      </ConfigContext.Provider>,
    );
  });
  return {
    host,
    text: () => host.textContent ?? "",
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

export async function waitFor<T>(fn: () => T | null | undefined | false, what = "condition", timeoutMs = 8000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let v: T | null | undefined | false;
    await act(async () => {
      v = fn();
    });
    if (v) return v as T;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

/** Set a field's value the way a user does, so React's onChange fires. */
export async function typeInto(el: Element, value: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    (el as HTMLElement).click();
  });
}

export function byText(root: ParentNode, selector: string, text: string | RegExp): HTMLElement | null {
  for (const e of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    const t = e.textContent ?? "";
    if (typeof text === "string" ? t.includes(text) : text.test(t)) return e;
  }
  return null;
}
