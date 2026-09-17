/* ------------------------------------------------------------------
   Mock data for the Nexora OS UI concept. No backend, no real logic.
   ------------------------------------------------------------------ */

export type DeptId =
  | "ceo"
  | "operations"
  | "engineering"
  | "sales"
  | "support"
  | "finance"
  | "conference";

export type Department = {
  id: DeptId;
  name: string;
  shortName: string;
  tagline: string;
  color: string;
  headcount: number;
  activeTasks: number;
  status: "focused" | "in meeting" | "shipping" | "closing" | "reconciling" | "on call";
  focus: string;
  lead: string; // agent id
  metric: { label: string; value: string; delta: string };
};

export const departments: Record<DeptId, Department> = {
  ceo: {
    id: "ceo",
    name: "Executive Office",
    shortName: "CEO",
    tagline: "Big ideas. Bigger impact.",
    color: "#f5b942",
    headcount: 2,
    activeTasks: 6,
    status: "in meeting",
    focus: "Q3 roadmap & capital plan",
    lead: "atlas",
    metric: { label: "OKR progress", value: "68%", delta: "+4 pts" },
  },
  operations: {
    id: "operations",
    name: "Operations",
    shortName: "Ops",
    tagline: "Turn plans into progress.",
    color: "#3dd68c",
    headcount: 7,
    activeTasks: 41,
    status: "focused",
    focus: "SOC 2 audit prep · vendor renewals",
    lead: "vera",
    metric: { label: "On-time delivery", value: "94%", delta: "+2%" },
  },
  engineering: {
    id: "engineering",
    name: "Engineering",
    shortName: "Eng",
    tagline: "Build what's next.",
    color: "#4f8bff",
    headcount: 14,
    activeTasks: 87,
    status: "shipping",
    focus: "Mobile v2 · API rate limiter",
    lead: "kai",
    metric: { label: "Deploys this week", value: "23", delta: "+6" },
  },
  sales: {
    id: "sales",
    name: "Sales",
    shortName: "Sales",
    tagline: "Conversations create opportunities.",
    color: "#ff8a3d",
    headcount: 8,
    activeTasks: 29,
    status: "closing",
    focus: "Acme enterprise · 12 open deals",
    lead: "nova",
    metric: { label: "Pipeline", value: "$4.8M", delta: "+18%" },
  },
  support: {
    id: "support",
    name: "Customer Support",
    shortName: "Support",
    tagline: "Happy customers, stronger together.",
    color: "#2fd4e6",
    headcount: 9,
    activeTasks: 18,
    status: "on call",
    focus: "Tier-1 queue · SLA 99.2%",
    lead: "iris",
    metric: { label: "Median response", value: "38s", delta: "-12s" },
  },
  finance: {
    id: "finance",
    name: "Finance",
    shortName: "Finance",
    tagline: "Disciplined today. A bigger tomorrow.",
    color: "#a78bfa",
    headcount: 4,
    activeTasks: 12,
    status: "reconciling",
    focus: "Monthly close · pricing study",
    lead: "ledger",
    metric: { label: "Runway", value: "31 mo", delta: "+2 mo" },
  },
  conference: {
    id: "conference",
    name: "Conference Room",
    shortName: "Meeting",
    tagline: "Different agents, a brighter tomorrow.",
    color: "#818cf8",
    headcount: 6,
    activeTasks: 3,
    status: "in meeting",
    focus: "Q3 Roadmap Sync (live)",
    lead: "atlas",
    metric: { label: "Decisions today", value: "4", delta: "2 pending" },
  },
};

export const deptList: Department[] = [
  departments.ceo,
  departments.operations,
  departments.engineering,
  departments.finance,
  departments.conference,
  departments.sales,
  departments.support,
];

export type Agent = {
  id: string;
  name: string;
  role: string;
  dept: DeptId;
  status: "online" | "busy" | "idle";
  tasksDone: number;
  onTime: number;
  quality: number;
  trend: number[];
};

export const agents: Agent[] = [
  { id: "atlas", name: "Atlas", role: "Chief Executive", dept: "ceo", status: "busy", tasksDone: 34, onTime: 97, quality: 4.9, trend: [3, 4, 4, 5, 6, 5, 7] },
  { id: "vera", name: "Vera", role: "Chief Operating Officer", dept: "operations", status: "online", tasksDone: 128, onTime: 95, quality: 4.8, trend: [12, 14, 13, 17, 18, 20, 22] },
  { id: "kai", name: "Kai", role: "Chief Technology Officer", dept: "engineering", status: "busy", tasksDone: 96, onTime: 92, quality: 4.9, trend: [9, 11, 10, 12, 15, 14, 16] },
  { id: "nova", name: "Nova", role: "Head of Sales", dept: "sales", status: "online", tasksDone: 71, onTime: 89, quality: 4.6, trend: [6, 8, 7, 9, 12, 11, 13] },
  { id: "iris", name: "Iris", role: "Support Lead", dept: "support", status: "online", tasksDone: 212, onTime: 99, quality: 4.9, trend: [24, 26, 28, 27, 30, 33, 35] },
  { id: "ledger", name: "Ledger", role: "Chief Financial Officer", dept: "finance", status: "busy", tasksDone: 58, onTime: 98, quality: 4.8, trend: [5, 6, 6, 8, 8, 9, 10] },
  { id: "sol", name: "Sol", role: "Head of Product", dept: "operations", status: "busy", tasksDone: 64, onTime: 93, quality: 4.7, trend: [6, 7, 9, 8, 10, 11, 12] },
  { id: "byte", name: "Byte", role: "Senior Engineer", dept: "engineering", status: "online", tasksDone: 143, onTime: 90, quality: 4.7, trend: [14, 15, 17, 16, 20, 22, 24] },
  { id: "pixel", name: "Pixel", role: "Frontend Engineer", dept: "engineering", status: "online", tasksDone: 119, onTime: 94, quality: 4.8, trend: [10, 12, 12, 14, 15, 17, 18] },
  { id: "forge", name: "Forge", role: "Platform Engineer", dept: "engineering", status: "idle", tasksDone: 88, onTime: 91, quality: 4.6, trend: [8, 9, 9, 11, 12, 12, 13] },
  { id: "ember", name: "Ember", role: "Growth & Marketing", dept: "sales", status: "online", tasksDone: 77, onTime: 88, quality: 4.5, trend: [7, 7, 9, 10, 10, 12, 14] },
  { id: "rio", name: "Rio", role: "Account Executive", dept: "sales", status: "busy", tasksDone: 52, onTime: 90, quality: 4.6, trend: [4, 5, 6, 6, 8, 9, 9] },
  { id: "echo", name: "Echo", role: "Support Specialist", dept: "support", status: "online", tasksDone: 188, onTime: 98, quality: 4.8, trend: [20, 22, 21, 25, 26, 28, 30] },
  { id: "lumen", name: "Lumen", role: "Support Specialist", dept: "support", status: "online", tasksDone: 164, onTime: 97, quality: 4.7, trend: [18, 19, 21, 22, 24, 25, 27] },
  { id: "cent", name: "Cent", role: "Financial Analyst", dept: "finance", status: "online", tasksDone: 49, onTime: 96, quality: 4.7, trend: [4, 5, 5, 6, 7, 8, 8] },
];

export const agentById = Object.fromEntries(agents.map((a) => [a.id, a])) as Record<string, Agent>;

export type RiskLevel = "low" | "medium" | "high";

export type Approval = {
  id: string;
  requester: string; // agent id
  action: string;
  summary: string;
  risk: RiskLevel;
  category: "deploy" | "contract" | "campaign" | "hire" | "pricing";
  requestedAgo: string;
  state: "pending" | "approved" | "rejected";
};

export const approvals: Approval[] = [
  {
    id: "ap-1",
    requester: "kai",
    action: "Deploy v1.5.0 to production",
    summary: "Ships the new rate limiter and mobile sync API. 312 tests passing, canary at 5% for 2h with no regressions.",
    risk: "medium",
    category: "deploy",
    requestedAgo: "4m",
    state: "pending",
  },
  {
    id: "ap-2",
    requester: "nova",
    action: "Send MSA contract to Acme Corp",
    summary: "$420k ARR, 24-month term, net-30. Legal agent reviewed; two non-standard clauses flagged in section 7.",
    risk: "high",
    category: "contract",
    requestedAgo: "11m",
    state: "pending",
  },
  {
    id: "ap-3",
    requester: "ember",
    action: "Approve Q3 lifecycle email campaign",
    summary: "6-touch sequence to 14,200 trial users. Projected +3.1% activation. Budget: $0, copy attached.",
    risk: "low",
    category: "campaign",
    requestedAgo: "26m",
    state: "pending",
  },
  {
    id: "ap-4",
    requester: "vera",
    action: "Hire a new agent: Senior QA Engineer",
    summary: "Engineering throughput is up 40% and QA is the bottleneck. Proposed spec and budget attached.",
    risk: "low",
    category: "hire",
    requestedAgo: "1h",
    state: "pending",
  },
  {
    id: "ap-5",
    requester: "ledger",
    action: "Change Pro plan pricing $49 → $59",
    summary: "Elasticity study shows <2% churn impact. Adds ~$86k MRR. Recommend grandfathering existing customers for 6 months.",
    risk: "high",
    category: "pricing",
    requestedAgo: "2h",
    state: "pending",
  },
];

export type ActivityItem = {
  id: string;
  agent: string;
  dept: DeptId;
  text: string;
  ago: string;
};

export const activity: ActivityItem[] = [
  { id: "a1", agent: "kai", dept: "engineering", text: "deployed v1.4.2 to production", ago: "3m" },
  { id: "a2", agent: "nova", dept: "sales", text: "moved Acme Corp to Negotiation", ago: "7m" },
  { id: "a3", agent: "echo", dept: "support", text: "resolved ticket #4821 (billing)", ago: "12m" },
  { id: "a4", agent: "ledger", dept: "finance", text: "closed August reconciliation", ago: "18m" },
  { id: "a5", agent: "atlas", dept: "ceo", text: "added company OKR: “Reach $2M MRR”", ago: "25m" },
  { id: "a6", agent: "vera", dept: "operations", text: "scheduled SOC 2 evidence review", ago: "31m" },
  { id: "a7", agent: "pixel", dept: "engineering", text: "opened PR #918: dashboard redesign", ago: "44m" },
  { id: "a8", agent: "iris", dept: "support", text: "published 3 new help-center articles", ago: "1h" },
];

export type Meeting = {
  id: string;
  title: string;
  room: string;
  startedAt: string;
  endsAt: string;
  progress: number; // 0..1
  participants: string[];
  agenda: { label: string; done: boolean }[];
  decisions: string[];
  actionItems: { text: string; owner: string; due: string }[];
};

export const currentMeeting: Meeting = {
  id: "m-1",
  title: "Q3 Roadmap Sync",
  room: "Conference Room · Live",
  startedAt: "10:00",
  endsAt: "10:45",
  progress: 0.55,
  participants: ["atlas", "vera", "kai", "nova", "ledger", "sol"],
  agenda: [
    { label: "Mobile v2 launch timing", done: true },
    { label: "Pricing change impact", done: true },
    { label: "Hiring plan: QA + SDR", done: false },
    { label: "Acme rollout risks", done: false },
  ],
  decisions: ["Ship Mobile v2 on Sep 30, not Oct 14", "Grandfather existing Pro customers for 6 months"],
  actionItems: [
    { text: "Draft launch comms for Mobile v2", owner: "ember", due: "Tomorrow" },
    { text: "Finalize QA agent job spec", owner: "vera", due: "Thu" },
    { text: "Model pricing scenarios B & C", owner: "cent", due: "Fri" },
  ],
};

export const upcomingMeetings = [
  { id: "m-2", title: "Support Quality Review", time: "11:30", dept: "support" as DeptId, participants: ["iris", "echo", "lumen"] },
  { id: "m-3", title: "Acme Deal Desk", time: "14:00", dept: "sales" as DeptId, participants: ["nova", "rio", "ledger"] },
];

export type Project = {
  id: string;
  name: string;
  dept: DeptId;
  owner: string;
  progress: number;
  due: string;
  health: "on track" | "at risk" | "blocked";
  tasks: { done: number; total: number };
};

export const projects: Project[] = [
  { id: "p1", name: "Nexora Mobile v2", dept: "engineering", owner: "kai", progress: 72, due: "Sep 30", health: "on track", tasks: { done: 94, total: 131 } },
  { id: "p2", name: "Acme Enterprise Rollout", dept: "sales", owner: "nova", progress: 45, due: "Oct 12", health: "at risk", tasks: { done: 18, total: 40 } },
  { id: "p3", name: "Support Copilot", dept: "support", owner: "iris", progress: 88, due: "Sep 19", health: "on track", tasks: { done: 52, total: 59 } },
  { id: "p4", name: "SOC 2 Audit Prep", dept: "operations", owner: "vera", progress: 31, due: "Nov 3", health: "on track", tasks: { done: 23, total: 74 } },
  { id: "p5", name: "Q3 Pricing Study", dept: "finance", owner: "ledger", progress: 60, due: "Sep 26", health: "blocked", tasks: { done: 9, total: 15 } },
];

export const kpis = [
  { id: "projects", label: "Active Projects", value: "24", delta: "+3 this week", up: true, color: "#4f8bff", spark: [14, 16, 15, 18, 19, 21, 21, 24] },
  { id: "tasks", label: "Tasks Completed", value: "342", delta: "+18% vs last week", up: true, color: "#3dd68c", spark: [180, 210, 205, 240, 260, 290, 310, 342] },
  { id: "csat", label: "Customer Satisfaction", value: "96%", delta: "+2 pts", up: true, color: "#ff5ca8", spark: [91, 92, 92, 93, 94, 94, 95, 96] },
  { id: "revenue", label: "Monthly Revenue", value: "$1.2M", delta: "+12% MoM", up: true, color: "#6d7cff", spark: [0.72, 0.8, 0.84, 0.9, 0.97, 1.05, 1.1, 1.2] },
];

export const companyHealth = {
  score: 92,
  parts: [
    { label: "People", value: 98, color: "#3dd68c" },
    { label: "Execution", value: 90, color: "#4f8bff" },
    { label: "Customers", value: 88, color: "#2fd4e6" },
    { label: "Revenue", value: 85, color: "#f5b942" },
  ],
};

export const companyStatus = {
  label: "All systems operational",
  agentsOnline: 47,
  agentsTotal: 52,
  meetingsLive: 1,
  pendingApprovals: approvals.filter((a) => a.state === "pending").length,
};

export const revenueSnapshot = {
  mrr: "$1.2M",
  arr: "$14.4M",
  growth: "+12%",
  series: [0.62, 0.66, 0.7, 0.72, 0.78, 0.8, 0.86, 0.92, 0.97, 1.05, 1.1, 1.2],
  months: ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"],
};
