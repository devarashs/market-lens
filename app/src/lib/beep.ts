/** Monster-trade alert: short sine blip, higher pitch for buys. Lazily
    creates the AudioContext on first use (browsers require a user gesture
    before audio; the enabling checkbox click provides one). */
let audioContext: AudioContext | null = null;

export function beep(side: "buy" | "sell"): void {
  try {
    audioContext = audioContext ?? new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = side === "buy" ? 880 : 440;
    gain.gain.setValueAtTime(0.06, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.15);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.15);
  } catch {
    // Audio is decoration — a blocked AudioContext must never break the tape.
  }
}
