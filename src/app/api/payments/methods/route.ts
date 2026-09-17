export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { createBankAccount, createCard, getSettings, listMethods } from "@/lib/payments/store";
import { jsonError, readJson, str } from "@/lib/api-helpers";
import { RuntimeError } from "@/lib/runtime/types";

export async function GET() {
  return NextResponse.json({ methods: listMethods(), defaultId: getSettings().defaultPaymentMethodId });
}

/** Owner only. Secrets go straight to the vault; the response carries safe metadata only. */
export async function POST(req: Request) {
  try {
    const b = await readJson<Record<string, unknown>>(req);
    const billing = (b.billing ?? {}) as Record<string, string>;
    if (b.type === "CARD") {
      const method = createCard({
        displayName: str(b.displayName, 80) ?? "", description: str(b.description, 1_000) ?? "", cardholderName: str(b.cardholderName, 120) ?? "", cardNumber: str(b.cardNumber, 32) ?? "",
        expirationMonth: Number(b.expirationMonth), expirationYear: Number(b.expirationYear), cvv: str(b.cvv, 4) || undefined,
        billing: { line1: billing.line1, city: billing.city, region: billing.region, postalCode: billing.postalCode, country: billing.country },
      });
      return NextResponse.json({ method }, { status: 201 });
    }
    if (b.type === "BANK_ACCOUNT") {
      const method = createBankAccount({
        displayName: str(b.displayName, 80) ?? "", description: str(b.description, 1_000) ?? "", accountHolderName: str(b.accountHolderName, 120) ?? "", bankName: str(b.bankName, 120) || undefined,
        routingNumber: str(b.routingNumber, 20) ?? "", accountNumber: str(b.accountNumber, 32) ?? "", accountType: b.accountType === "SAVINGS" ? "SAVINGS" : "CHECKING",
        billing: Object.keys(billing).length ? { line1: billing.line1, city: billing.city, region: billing.region, postalCode: billing.postalCode, country: billing.country } : undefined,
      });
      return NextResponse.json({ method }, { status: 201 });
    }
    throw new RuntimeError("type must be CARD or BANK_ACCOUNT");
  } catch (err) {
    return jsonError(err);
  }
}
