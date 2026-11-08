// A fake Ollama's pieces for the tests (an HTTP server, never a model): a reply still being
// generated, and a wait for the client to close it.

/**
 * A reply still being generated: its headers go out at once, then a space every 20 ms; the
 * returned `closed` settles when the client closes the connection. It gives up after 3 s (so a
 * client that never closes fails the test instead of hanging it).
 */
export function generating(): { response: Response; closed: Promise<void> } {
  let onClosed: () => void = () => {};
  const closed = new Promise<void>((r) => onClosed = r);
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const began = Date.now();
      timer = setInterval(() => {
        if (Date.now() - began < 3000) c.enqueue(new TextEncoder().encode(" "));
        else {
          clearInterval(timer);
          c.close();
        }
      }, 20);
    },
    cancel() {
      clearInterval(timer);
      onClosed();
    },
  });
  const response = new Response(body, {
    headers: { "content-type": "application/json" },
  });
  return { response, closed };
}

/** Settles when `closed` does; rejects when that takes longer than `ms`. */
export async function closedWithin(
  closed: Promise<void>,
  ms = 2000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        timer = setTimeout(
          () => reject(new Error("the request was not closed")),
          ms,
        )
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
