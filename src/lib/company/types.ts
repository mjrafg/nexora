/* ------------------------------------------------------------------
   Company Profile — the canonical company information every agent uses
   instead of guessing: identity, contact methods (each with a purpose
   description the agent reasons from), addresses and optional legal /
   registration data.

   Owner-only to edit; agents read it with get_company_profile and ask
   for a genuinely missing value with request_company_info (owner fills
   it in the UI, the agent resumes automatically). Nothing here is ever
   invented: an absent field stays absent.
   ------------------------------------------------------------------ */

export type Address = {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
};

export type CompanyContactType = "EMAIL" | "PHONE";
export type CompanyContactStatus = "ACTIVE" | "INACTIVE";

export type CompanyContact = {
  id: string;
  type: CompanyContactType;
  /** short label, e.g. "Primary Company Email", "Company Phone" */
  name: string;
  value: string;
  /** what this contact is for — agents choose between contacts by this */
  description: string;
  isPrimary: boolean;
  status: CompanyContactStatus;
  /** "owner" or the id of the agent that saved it */
  createdBy: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type CompanyLegal = {
  entityType?: string;
  registrationState?: string;
  registrationCountry?: string;
  formationDate?: string;
  /** EIN / VAT / tax identifier — masked in the UI, never written to activity */
  taxId?: string;
  registrationNumber?: string;
  registeredAddress?: Address;
};

export type CompanyProfile = {
  id: "company";
  name: string;
  legalName?: string;
  entityType?: string;
  industry?: string;
  website?: string;
  description?: string;
  timezone?: string;
  /** the person who owns/represents the company — what forms call "your name", "account holder", "authorized representative" */
  ownerFirstName?: string;
  ownerLastName?: string;
  ownerTitle?: string;
  address: Address;
  billingSameAsCompany: boolean;
  billingAddress: Address;
  legal: CompanyLegal;
  contacts: CompanyContact[];
  /** "owner" or the id of the agent that last changed the record */
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};

/** what the UI receives: the tax identifier is masked unless explicitly revealed */
export type CompanyProfileView = Omit<CompanyProfile, "legal"> & {
  legal: Omit<CompanyLegal, "taxId"> & { taxId?: string; taxIdMasked?: string; hasTaxId: boolean };
  /** billingAddress resolved from the company address when "same as" is on */
  resolvedBillingAddress: Address;
};

export type CompanyInfoRequestStatus = "WAITING" | "RESOLVED" | "CANCELLED";

export type CompanyInfoRequest = {
  id: string;
  requesterAgentId: string;
  requesterName: string;
  /** canonical field key (see FIELDS), or a Custom Data key when the agent asked for a reusable value */
  field: string;
  /** which surface holds it: the structured profile, or the Custom Data table */
  target: "profile" | "custom_data";
  label: string;
  /** what needs it, e.g. "Google Ads account signup" */
  neededBy: string;
  reason: string;
  status: CompanyInfoRequestStatus;
  /** requester's execution scope — the resume continues it */
  executionScopeId?: string;
  capabilityRequestId?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resumedAt?: string;
};

/* ---------------------------------------------------------------- custom data */

export type CustomValueType = "string" | "number" | "boolean" | "date" | "url" | "email" | "phone" | "json";
/** verified = the owner stands behind it. provisional = an agent chose it to keep working. */
export type CustomDataStatus = "verified" | "provisional";
export type CustomDataSource = "owner" | "agent" | "import" | "system";

export type CustomDatum = {
  id: string;
  /** namespaced and uniquely addressable, e.g. signup.default_country */
  key: string;
  /** stored as text; `valueType` says how to read it */
  value: string;
  valueType: CustomValueType;
  label?: string;
  description?: string;
  status: CustomDataStatus;
  source: CustomDataSource;
  /** why an agent chose a provisional value */
  reason?: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type CompanyActivityKind =
  | "profile_updated"
  | "contact_added"
  | "contact_updated"
  | "contact_removed"
  | "billing_updated"
  | "legal_updated"
  | "info_requested"
  | "info_provided"
  | "read";

/** who made a change: the owner, or an authorized agent (id + name) */
export type Actor = { kind: "owner" } | { kind: "agent"; id: string; name: string; reason?: string };

export type CompanyActivity = {
  id: string;
  ts: number;
  kind: CompanyActivityKind;
  /** never contains field values — only which fields changed */
  text: string;
  agentId?: string;
  /** free-text reason an agent gave for a write */
  reason?: string;
  requestId?: string;
};
