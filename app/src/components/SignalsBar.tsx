import type { SignalReading } from "../lib/types";
import { useLensStore } from "../store/lens";

function SignalCell({ name, signal }: { name: string; signal: SignalReading }) {
  const width = Math.min(45, (Math.abs(signal.score) / 100) * 45);
  const positive = signal.score >= 0;
  const title = Object.entries(signal.parts ?? {})
    .map(([key, value]) => `${key}: ${value}`).join(" · ");
  return (
    <span className="signal" title={title}>
      <span className="name">{name}</span>
      <span className="bar">
        <i style={{
          left: positive ? "50%" : `${50 - width}%`,
          width: `${width}%`,
          background: positive ? "var(--bid)" : "var(--ask)",
        }} />
      </span>
      <span className={`val ${positive ? "buy-c" : "sell-c"}`}>
        {signal.score > 0 ? "+" : ""}{signal.score}
      </span>
    </span>
  );
}

/** The automated readers strip: tape, book, combined + verdict. */
export function SignalsBar() {
  const signals = useLensStore((s) => s.depth?.signals);

  if (!signals) {
    return <div className="signals"><span className="muted">readers warming up…</span></div>;
  }
  return (
    <div className="signals">
      <SignalCell name="tape" signal={signals.tape} />
      <SignalCell name="book" signal={signals.book} />
      <SignalCell name="both" signal={signals.combined} />
      <span className={`verdict ${signals.combined.verdict.includes("absorption") ? "warn" : ""}`}>
        {signals.combined.verdict}
      </span>
    </div>
  );
}
