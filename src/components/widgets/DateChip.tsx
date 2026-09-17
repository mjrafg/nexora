import { Sun } from "lucide-react";

export function DateChip() {
  return (
    <div className="glass flex items-center justify-between rounded-2xl px-4 py-3">
      <div>
        <div className="text-[11px] text-ink-3">Tue, Sep 15, 2026</div>
        <div className="text-[22px] font-semibold tracking-tight num leading-tight">10:24 <span className="text-[13px] text-ink-2">AM</span></div>
      </div>
      <div className="flex items-center gap-2 text-right">
        <div>
          <div className="text-[10.5px] text-ink-3">San Francisco</div>
          <div className="text-[15px] font-semibold num">68°F</div>
          <div className="text-[10px] text-ink-3">Clear skies for bold ideas.</div>
        </div>
        <Sun className="h-6 w-6 text-ceo" strokeWidth={1.6} />
      </div>
    </div>
  );
}
