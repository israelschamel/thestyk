// The demo's stand-in for the tag's buzzer: the same triple-beep pattern, played by this phone.

let ctx = null;
let current = null;

function audio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Plays about 10 seconds of triple beeps. Returns a stop function.
export function playFindPattern(onEnd = () => {}) {
  stopSound();
  const ac = audio();
  const done = () => { if (current?.onEnd === onEnd) { current = null; onEnd(); } };
  if (!ac) {
    const timer = setTimeout(done, 10000);
    current = { stop: () => clearTimeout(timer), onEnd };
    return stopSound;
  }
  const gain = ac.createGain();
  gain.gain.value = 0;
  gain.connect(ac.destination);
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 2700;
  osc.connect(gain);

  const t0 = ac.currentTime + 0.05;
  let t = t0;
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < 3; i++) {
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.01);
      gain.gain.setValueAtTime(0.18, t + 0.11);
      gain.gain.linearRampToValueAtTime(0, t + 0.12);
      t += 0.23;
    }
    t += 0.6;
  }
  osc.start(t0);
  osc.stop(t);
  const timer = setTimeout(done, (t - ac.currentTime) * 1000);
  current = {
    onEnd,
    stop: () => {
      clearTimeout(timer);
      try { gain.gain.cancelScheduledValues(ac.currentTime); gain.gain.setValueAtTime(0, ac.currentTime); osc.stop(); } catch { /* already stopped */ }
    },
  };
  return stopSound;
}

export function stopSound() {
  if (!current) return;
  const c = current;
  current = null;
  c.stop();
  c.onEnd();
}

export function soundPlaying() {
  return !!current;
}
