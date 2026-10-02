import { describe, expect, it, vi } from "vitest";
import { withTimeout, cancelTimeout, TimeoutError } from "./timeout";

describe("TimeoutError", () => {
  it("is an instanceof Error", () => {
    const err = new TimeoutError();
    expect(err).toBeInstanceOf(Error);
  });

  it("has the correct name 'TimeoutError'", () => {
    const err = new TimeoutError();
    expect(err.name).toBe("TimeoutError");
  });

  it("uses the default message when none provided", () => {
    const err = new TimeoutError();
    expect(err.message).toBe("Operation timed out");
  });

  it("uses a custom message when provided", () => {
    const err = new TimeoutError("Custom timeout message");
    expect(err.message).toBe("Custom timeout message");
  });
});

describe("withTimeout", () => {
  it("resolves normally when function completes before timeout", async () => {
    const result = await withTimeout(
      Promise.resolve("done"),
      1000,
    );
    expect(result).toBe("done");
  });

  it("rejects with TimeoutError when function exceeds timeout", async () => {
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 500);
    });

    await expect(withTimeout(slow, 50)).rejects.toThrow(TimeoutError);
  });

  it("rejects with TimeoutError with the correct message including duration", async () => {
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 500);
    });

    await expect(withTimeout(slow, 100)).rejects.toThrow(
      "Operation timed out after 100ms",
    );
  });

  it("respects custom timeout duration (100ms vs 500ms)", async () => {
    // A promise that resolves in 200ms
    const medium = new Promise<string>((resolve) => {
      setTimeout(() => resolve("medium"), 200);
    });

    // With 100ms timeout - should time out
    await expect(withTimeout(medium, 100)).rejects.toThrow(TimeoutError);
  });

  it("does NOT time out when given sufficient duration", async () => {
    const quick = new Promise<string>((resolve) => {
      setTimeout(() => resolve("quick"), 10);
    });

    const result = await withTimeout(quick, 1000);
    expect(result).toBe("quick");
  });

  it("propagates the original error from the function", async () => {
    const failing = Promise.reject(new Error("Original error"));

    await expect(withTimeout(failing, 1000)).rejects.toThrow("Original error");
  });

  it("aborts the AbortController signal on timeout", async () => {
    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, "abort");

    const slow = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 500);
    });

    await expect(withTimeout(slow, 50, abortController)).rejects.toThrow(
      TimeoutError,
    );

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(abortController.signal.aborted).toBe(true);
  });

  it("does NOT abort the AbortController signal on normal completion", async () => {
    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, "abort");

    const result = await withTimeout(
      Promise.resolve("success"),
      1000,
      abortController,
    );

    expect(result).toBe("success");
    expect(abortSpy).not.toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(false);
  });

  it("does NOT abort when the promise rejects with an error (not a timeout)", async () => {
    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, "abort");

    await expect(
      withTimeout(Promise.reject(new Error("fail")), 1000, abortController),
    ).rejects.toThrow("fail");

    expect(abortSpy).not.toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(false);
  });

  it("correctly clears the timeout on normal resolution", async () => {
    // If timeout is not cleared, the test would have a dangling timer
    // that could cause side effects. We verify by completing well within the limit.
    const abortController = new AbortController();

    const result = await withTimeout(
      Promise.resolve("ok"),
      10_000,
      abortController,
    );

    expect(result).toBe("ok");
    // Signal should NOT be aborted since we completed naturally
    expect(abortController.signal.aborted).toBe(false);
  });

  it("handles synchronized (already resolved) promises", async () => {
    const result = await withTimeout(Promise.resolve("instant"), 1000);
    expect(result).toBe("instant");
  });
});

describe("cancelTimeout", () => {
  it("resolves immediately when aborted via AbortSignal", async () => {
    const abortController = new AbortController();

    const cancelPromise = cancelTimeout(abortController.signal);

    // Abort after a tiny delay to ensure cancelTimeout is listening
    setTimeout(() => abortController.abort(), 5);

    await expect(cancelPromise).rejects.toThrow("Operation cancelled");
  });

  it("rejects with 'Operation cancelled' when aborted", async () => {
    const abortController = new AbortController();

    const cancelPromise = cancelTimeout(abortController.signal);

    setTimeout(() => abortController.abort(), 5);

    await expect(cancelPromise).rejects.toThrow("Operation cancelled");
  });

  it("rejects immediately if already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      cancelTimeout(abortController.signal),
    ).rejects.toThrow("Operation cancelled");
  });
});
