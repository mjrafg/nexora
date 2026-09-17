"use client";

import { OfficeView } from "@/components/office/OfficeView";

/** Dev-only: the live office on its own, for visual inspection. */
export default function ScenePage() {
  return (
    <div className="p-3">
      <div className="glass overflow-hidden rounded-2xl">
        <OfficeView />
      </div>
    </div>
  );
}
