// Fakes shared by the web tile tests (tests/web_tile_test.ts, tests/web_native_test.ts).

/** A fake focused field: records what reached it. */
export function fakeField(tagName: string, opts: Record<string, unknown> = {}) {
  const events: Event[] = [];
  const field = {
    tagName,
    type: "text",
    value: "abc",
    selectionStart: 1 as number | null,
    selectionEnd: 2 as number | null,
    disabled: false,
    readOnly: false,
    isContentEditable: false,
    setRangeText(text: string, start: number, end: number) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
    },
    dispatchEvent(e: Event) {
      events.push(e);
      return true;
    },
    ...opts,
  };
  return { field, events };
}
