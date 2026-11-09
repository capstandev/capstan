// AppKit's open() does not wait for its own setup. The WalletConnect connector is added to the list only when the
// universal provider is ready, and the picker's connector list does not re-render when a connector arrives later. A
// picker opened too early can show only the injected wallets, with no WalletConnect row, until something else makes
// it re-render. So wait for ready() first, but never longer than waitMs: the picker must always open.

/** The time the picker waits for AppKit's setup before it opens anyway. */
export const READY_WAIT_MS = 5_000;

type Openable = { ready(): Promise<void>; open(): Promise<unknown> };

/** Opens the picker once AppKit is ready, or after waitMs, whichever comes first. A failed setup still opens it. */
export async function openWhenReady(kit: Openable, waitMs = READY_WAIT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  try {
    await Promise.race([kit.ready().catch(() => undefined), bound]);
  } finally {
    clearTimeout(timer);
  }
  await kit.open();
}
