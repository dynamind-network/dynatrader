export function createSelectionRedrawScheduler(redraw: () => void, intervalMs = 20) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        redraw();
      }, intervalMs);
    },
    flush(force = false) {
      if (!timer && !force) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      redraw();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
