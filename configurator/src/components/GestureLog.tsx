import { useEffect, useRef, useSyncExternalStore } from "react";
import { clearGestureLog, gestureLog, setGestureLogOn, subscribeGestureLog } from "../debug/gesture-log";

/**
 * The gesture log, live.
 *
 * Newest at the bottom and scrolled to, the way a console reads: what just happened is
 * what you are looking for, and the run-up to it is right above.
 */
export function GestureLog() {
  const entries = useSyncExternalStore(subscribeGestureLog, gestureLog);
  const tail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = tail.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [entries]);

  return (
    <div className="gesture-log">
      <div className="gesture-log-header">
        <h3>Gestures</h3>
        <div className="gesture-log-actions">
          <button type="button" className="gesture-log-btn" onClick={clearGestureLog}>
            Clear
          </button>
          <button type="button" className="gesture-log-btn" onClick={() => setGestureLogOn(false)}>
            Off
          </button>
        </div>
      </div>
      <div className="gesture-log-entries" ref={tail}>
        {entries.length === 0 ? (
          <p className="gesture-log-empty">Nothing yet — press a button in the viewport.</p>
        ) : (
          entries.map((entry) => (
            <div className="gesture-log-entry" key={entry.id}>
              <span className="gesture-log-time">{(entry.at / 1000).toFixed(2)}s</span>
              <span className="gesture-log-kind">{entry.kind}</span>
              {entry.detail && <span className="gesture-log-detail">{entry.detail}</span>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
