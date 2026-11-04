// Plays SysEx messages to a Web MIDI output on schedule. Messages are queued well ahead with timestamps, because
// the browser keeps to those even while it pauses a hidden page's timers.
//
// The rule that matters: a gap is never shorter than scheduled. If the page falls behind, the rest of the schedule
// moves back. It never catches up with a burst, which the keyboard could not take.

const START_DELAY_MS = 500;
const MIN_LEAD_MS = 5;
const TICK_MS = 50;
const REPORT_LATE_MS = 20;

/** IAC buses drop bulk SysEx. Other virtual ports are fine, and dry runs need them. */
export const isRefusedPort = name => /\bIAC\b/i.test(name);

export function createSender({ output, messages, due, clock = performance, timers = globalThis, lookaheadMs = 60000,
  onLog = () => {}, onProgress = () => {} }) {
  const total = messages.length;
  const queuedAt = [];  // the `when` of each message handed to the output
  let started = false, stopping = false, failed = false, unsure = false, finished = false;
  let next = 0, shift = 0, base = 0, timer = null, resolve = null;

  const scheduled = i => base + shift + due[i] * 1000;

  function finish(result) {
    if (finished) return;
    finished = true;
    timers.clearInterval(timer);
    resolve(result);
  }

  function queue(now) {
    while (next < total && !stopping && scheduled(next) < now + lookaheadMs) {
      const gap = next ? (due[next] - due[next - 1]) * 1000 : 0;
      const earliest = Math.max(now + MIN_LEAD_MS, next ? queuedAt[next - 1] + gap : 0);
      let when = scheduled(next);
      if (when < earliest) {
        const late = earliest - when;
        shift += late;
        when = earliest;
        if (late > REPORT_LATE_MS) onLog(`Message ${next + 1} was ${Math.round(late)} ms late. The rest of the schedule moved back to keep the gaps.`);
      }
      output.send(messages[next], when);
      queuedAt.push(when);
      next++;
    }
  }

  function tick() {
    if (finished) return;
    const now = clock.now();
    try {
      queue(now);
    } catch (error) {
      fail(`Sending failed at message ${next + 1}: ${error.message}`);
      return;
    }
    const sent = queuedAt.filter(when => when <= now).length;
    const end = stopping ? queuedAt[queuedAt.length - 1] ?? now : scheduled(total - 1);
    onProgress({ sent, total, secondsLeft: Math.max(0, (end - now) / 1000) });
    if ((next >= total || stopping) && sent === queuedAt.length) finish(failed ? 'failed' : unsure ? 'unsure' : stopping ? 'stopped' : 'done');
  }

  /** Once everything is queued, nobody can say how much arrived, so the result is 'unsure' rather than 'failed'. */
  function fail(reason) {
    onLog(reason);
    if (next >= total) unsure = true;
    else failed = stopping = true;
  }

  return {
    start() {
      if (started) return Promise.reject(new Error('This send has already started.'));
      started = true;
      base = clock.now() + START_DELAY_MS;
      return new Promise(done => {
        resolve = done;
        timer = timers.setInterval(tick, TICK_MS);
        tick();
      });
    },
    /**
     * Ends the queuing. Messages already queued can't be recalled, so start() resolves once their time has passed.
     * Returns whether anything was held back. If not, Stop changes nothing: the send carries on to its normal end.
     */
    stop() {
      if (next >= total) return false;
      stopping = true;
      return true;
    },
    /** For when the port disappears. Like stop(), this waits out the queue, in case the port comes back and it plays. */
    fail,
  };
}
