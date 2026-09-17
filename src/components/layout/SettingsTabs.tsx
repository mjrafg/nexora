"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plug, Server, Globe, FileText, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";

const tabs = [
  { href: "/settings/providers", label: "AI Providers", icon: Plug },
  { href: "/settings/mcp", label: "Tools & MCP", icon: Server },
  { href: "/settings/browser", label: "Browser Lab", icon: Globe },
  { href: "/settings/prompts", label: "Prompts", icon: FileText },
  { href: "/settings/skills", label: "Skills", icon: BookOpen },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    // narrow screens scroll the tabs rather than stacking their labels into
    // two- and three-line columns
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none] [&::-webkit-scrollbar]{display:none}">
      {tabs.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] transition-colors",
              active ? "border-brand text-ink" : "border-transparent text-ink-3 hover:text-ink-2"
            )}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
          </Link>
        );
      })}
    </div>
  );
}
