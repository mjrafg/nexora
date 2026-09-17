import { ReactNode } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { cn } from "@/lib/utils";

/**
 * `workspace` turns the shell into an application frame: the page itself never
 * scrolls, the children fill what is left under the top bar, and scrolling is
 * whatever the page puts inside it (the chat transcript, for example).
 */
export function AppShell({ children, workspace }: { children: ReactNode; workspace?: boolean }) {
  return (
    <div className={cn("flex gap-4", workspace ? "h-[100dvh] overflow-hidden" : "min-h-screen")}>
      <Sidebar />
      <main className={cn("flex min-w-0 flex-1 flex-col px-4", workspace ? "h-[100dvh] overflow-hidden pb-3" : "pb-8")}>
        <TopBar />
        {workspace ? <div className="flex min-h-0 flex-1 flex-col">{children}</div> : children}
      </main>
    </div>
  );
}
