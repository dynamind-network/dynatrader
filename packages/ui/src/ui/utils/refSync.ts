import { useRef, useCallback } from 'react';

/**
 * useRefSync - Returns a [ref, stableCallback] tuple where the ref always
 * holds the latest value and the callback is stable (never recreated).
 *
 * This pattern eliminates stale closures by ensuring that any callback
 * captured in a closure (e.g., in useEffect, setInterval, or event handlers)
 * always reads the current value via the ref.
 *
 * Reference pattern: StatusLine.tsx lines 157-167
 *   const settingsRef = useRef(settings);
 *   settingsRef.current = settings;
 *   const vimModeRef = useRef(vimMode);
 *   vimModeRef.current = vimMode;
 *
 * Combined with stable callback pattern (lines 190-195):
 *   const doUpdate = useCallback(async () => {
 *     const msgs = messagesRef.current;
 *     // ... always reads latest values from refs
 *   }, []); // Empty deps = truly stable
 *
 * @param value - The value to keep in sync with the ref.
 * @returns A tuple of [MutableRefObject<T>, () => T] where:
 *   - ref.current always holds the latest value
 *   - stableCallback() returns the current ref value and is never recreated
 *
 * @example
 * function MyComponent({ userId }) {
 *   const [userRef, getUser] = useRefSync(userId);
 *
 *   const fetchUser = useCallback(async () => {
 *     // Always reads latest userId, no stale closure
 *     const id = getUser();
 *     const res = await fetch(`/api/users/${id}`);
 *     return res.json();
 *   }, []); // Empty deps - stable reference
 *
 *   useEffect(() => {
 *     const interval = setInterval(fetchUser, 5000);
 *     return () => clearInterval(interval);
 *   }, [fetchUser]); // fetchUser never changes, effect runs once
 *
 *   return <div>User: {userRef.current}</div>;
 * }
 */
export function useRefSync<T>(value: T): [React.MutableRefObject<T>, () => T] {
  const ref = useRef<T>(value);
  ref.current = value;

  const stableCallback = useCallback(() => ref.current, []);

  return [ref, stableCallback];
}

