/** Re-exports so the export module does not reach across domains for shapes. */
export type { ChatMessage } from "@/lib/runtime/types";
export type ToolCallRecordLike = import("@/lib/mcp/types").ToolCallRecord;
