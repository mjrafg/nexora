import { cn } from "@/lib/utils";
import { shade } from "@/lib/iso";
import { agentById, departments, type DeptId } from "@/lib/mock-data";

/** Stylized android avatar tinted by department color. */
export function AgentAvatar({
  id,
  size = 28,
  ring = false,
  className,
  status,
  dept,
  name,
  online,
}: {
  id: string;
  size?: number;
  ring?: boolean;
  className?: string;
  status?: boolean;
  /** Department + name for agents that are not in the static mock data. */
  dept?: DeptId;
  name?: string;
  online?: "online" | "busy" | "idle";
}) {
  const agent = agentById[id];
  const deptId = dept ?? agent?.dept;
  const color = deptId ? departments[deptId].color : "#6d7cff";
  const title = agent ? `${agent.name} · ${agent.role}` : name ?? id;
  const presence = online ?? agent?.status;
  const r = size * 0.32;
  return (
    <span
      className={cn("relative inline-block shrink-0", className)}
      style={{ width: size, height: size }}
      title={title}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        className="rounded-full"
        style={{
          background: `linear-gradient(145deg, ${shade(color, -0.55)}, ${shade(color, -0.8)})`,
          boxShadow: ring ? `0 0 0 2px #0b1220, 0 0 0 3px ${color}` : `0 0 0 1px rgba(255,255,255,0.08)`,
          borderRadius: r,
        }}
      >
        <defs>
          <linearGradient id={`hd-${id}`} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#f4f6fb" />
            <stop offset="1" stopColor="#b9c1d3" />
          </linearGradient>
        </defs>
        {/* shoulders */}
        <path d="M6 32c1-6 5-9 10-9s9 3 10 9z" fill={shade(color, -0.25)} />
        <path d="M13 24h6v3h-6z" fill="#d8dde8" />
        {/* head */}
        <rect x="9" y="6" width="14" height="16" rx="6" fill={`url(#hd-${id})`} />
        {/* visor */}
        <rect x="11.5" y="11.5" width="9" height="4" rx="2" fill={shade(color, -0.6)} />
        <rect x="12.5" y="12.5" width="7" height="2" rx="1" fill={color} />
        {/* antenna */}
        <circle cx="16" cy="4.5" r="1.4" fill={color} />
      </svg>
      {status && (
        <span
          className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg-2"
          style={{ background: presence === "idle" ? "#f5b942" : "#3dd68c" }}
        />
      )}
    </span>
  );
}

export function AvatarStack({ ids, size = 24, max = 5 }: { ids: string[]; size?: number; max?: number }) {
  const shown = ids.slice(0, max);
  const rest = ids.length - shown.length;
  return (
    <div className="flex items-center">
      {shown.map((id, i) => (
        <AgentAvatar key={id} id={id} size={size} className={i > 0 ? "-ml-2" : ""} ring />
      ))}
      {rest > 0 && (
        <span
          className="-ml-2 grid place-items-center rounded-full bg-surface-2 text-[10px] font-medium text-ink-2 ring-2 ring-bg-2"
          style={{ width: size, height: size }}
        >
          +{rest}
        </span>
      )}
    </div>
  );
}
