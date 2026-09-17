/* ------------------------------------------------------------------
   Payments MVP — types.

   Payment-method SECRETS live in the Credential Vault (encrypted, hidden
   from the MCP credential list); PaymentMethod rows carry safe metadata
   plus a USAGE DESCRIPTION the agent reasons from. Agents never receive
   the secrets: they create a PaymentRequest, the backend applies the
   owner's threshold deterministically, and only an active authorization
   (30 min, per agent + request) lets insert_payment_method_fields type
   the vault values straight into the agent's browser session.

   Payment methods are a separate registry from login credentials
   (src/lib/credentials): different data, tools, permissions and approval
   rules — only the browser element-reference insertion pattern is shared.

   TEMPORARY: raw card and bank details in a vault is an MVP shortcut for a
   private deployment. Replace with tokenized / virtual-card infrastructure
   before broader production use.
   ------------------------------------------------------------------ */

export type PaymentMethodType = "CARD" | "BANK_ACCOUNT";
export type BankAccountType = "CHECKING" | "SAVINGS";
export type CardBrand = "Visa" | "Mastercard" | "American Express" | "Discover" | "Card";
export type PaymentMethodStatus = "AVAILABLE" | "DISABLED";

export type PaymentMethod = {
  id: string;
  type: PaymentMethodType;
  displayName: string;
  /** usage description agents reason from: what it is, when to use it, when not to */
  description: string;
  status: PaymentMethodStatus;
  /** CARD */
  brand?: CardBrand;
  cardholderName?: string;
  expirationMonth?: number;
  expirationYear?: number;
  /** BANK_ACCOUNT (US now; IBAN/SWIFT/country fields can be added later) */
  accountHolderName?: string;
  bankName?: string;
  accountType?: BankAccountType;
  country: string;
  /** shared safe metadata */
  last4: string;
  billing?: { line1?: string; city?: string; region?: string; postalCode?: string; country?: string };
  /** vault credential holding the secret values */
  credentialId: string;
  /** vault keys present (never values) */
  secretKeys: string[];
  /** "owner" or the agent id that saved it */
  createdBy: string;
  lastUsedAt?: string;
  lastUsedBy?: string;
  useCount: number;
  createdAt: string;
  updatedAt: string;
};

/** What agents see from list_payment_methods — never a secret. */
export type PaymentMethodView = {
  id: string;
  name: string;
  type: PaymentMethodType;
  brand?: CardBrand;
  last4: string;
  expiration?: string;
  cardholder_name?: string;
  bank_name?: string;
  account_type?: BankAccountType;
  billing_country?: string;
  has_cvv?: boolean;
  description: string;
  is_default: boolean;
  status: PaymentMethodStatus;
};

export type PaymentSettings = {
  /** payments at or below this amount (in `currency`) proceed automatically; default 0 */
  autoApproveLimit: number;
  currency: "USD";
  defaultPaymentMethodId: string | null;
  updatedAt: string;
};

export type PaymentRequestStatus =
  | "AUTO_APPROVED"
  | "WAITING_FOR_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export type BillingType = "ONE_TIME" | "RECURRING";
export type BillingInterval = "MONTHLY" | "YEARLY";
export type PreferredMethod = "CARD" | "BANK_ACCOUNT" | "ANY";
export type ApprovalType = "AUTOMATIC" | "OWNER" | "REJECTED" | "NONE";

export type PaymentRequest = {
  id: string;
  requestedByAgentId: string;
  requestedByName: string;
  merchant: string;
  amount: number;
  currency: "USD";
  reason: string;
  billingType: BillingType;
  interval?: BillingInterval;
  preferredMethod: PreferredMethod;
  recommendation?: string;
  status: PaymentRequestStatus;
  approvalType: ApprovalType;
  selectedPaymentMethodId: string | null;
  /** safe snapshot of the selected method (survives method deletion) */
  methodSnapshot?: { type: PaymentMethodType; displayName: string; last4: string; brand?: string };
  approvalThresholdAtCreation: number;
  approvedBy?: string;
  approvedAt?: string;
  rejectedAt?: string;
  ownerNote?: string;
  /** execution scope of the requesting turn — approval resumes the agent in this scope */
  executionScopeId?: string;
  /** capability request this payment belongs to (Capability Manager flow) */
  capabilityRequestId?: string;
  /** set by complete_payment */
  actualAmount?: number;
  externalReference?: string;
  completionNote?: string;
  completedAt?: string;
  /** owner-visible warning (e.g. reported amount above authorized maximum) */
  exception?: string;
  createdAt: string;
  updatedAt: string;
};

export type PaymentAuthorization = {
  id: string;
  paymentRequestId: string;
  /** null = the agent chooses any AVAILABLE method by its usage description */
  paymentMethodId: string | null;
  agentId: string;
  maxAmount: number;
  currency: "USD";
  createdAt: string;
  expiresAt: string;
  status: "ACTIVE" | "USED" | "EXPIRED" | "REVOKED";
};

export type PaymentTransaction = {
  id: string;
  paymentRequestId: string;
  agentId: string;
  agentName: string;
  merchant: string;
  amount: number;
  currency: "USD";
  status: "SUCCEEDED" | "FAILED" | "REJECTED" | "CANCELLED";
  billingType: BillingType;
  interval?: BillingInterval;
  reason: string;
  /** safe snapshot so history survives method deletion */
  paymentMethodType?: PaymentMethodType;
  paymentMethodDisplayName?: string;
  paymentMethodLast4?: string;
  paymentMethodBrand?: string;
  approvalType: ApprovalType;
  approvalThreshold: number;
  approvedBy?: string;
  approvedAt?: string;
  requestedAt: string;
  externalReference?: string;
  /** side-effect guard execution id of begin_payment, when known */
  executionId?: string;
  note?: string;
  createdAt: string;
  completedAt: string;
};

export type PaymentOverview = {
  currency: "USD";
  monthTotal: number;
  monthAuto: number;
  monthOwner: number;
  pendingApprovals: number;
  processing: number;
  methods: number;
  autoApproveLimit: number;
};
