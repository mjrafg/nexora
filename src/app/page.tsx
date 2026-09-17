"use client";

import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { OfficeView } from "@/components/office/OfficeView";
import { KpiStrip } from "@/components/widgets/KpiStrip";
import { ProjectsPanel } from "@/components/widgets/ProjectsPanel";
import { RevenueSnapshot } from "@/components/widgets/RevenueSnapshot";
import { DateChip } from "@/components/widgets/DateChip";
import { OpenWork } from "@/components/widgets/OpenWork";

export default function Home() {
  return (
    <div className="flex min-h-screen gap-4">
      <Sidebar />
      <main className="min-w-0 flex-1 px-4 pb-8">
        <TopBar />
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_340px]">
          {/* Center column */}
          <div className="min-w-0 space-y-4">
            <div className="glass overflow-hidden rounded-2xl">
              <OfficeView />
            </div>
            <KpiStrip />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <ProjectsPanel />
              <RevenueSnapshot />
            </div>
          </div>

          {/* Right rail */}
          <aside className="space-y-4">
            <DateChip />
            <OpenWork />
          </aside>
        </div>
      </main>
    </div>
  );
}
