export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { deleteMethod, updateMethod } from "@/lib/payments/store";
import { jsonError, readJson, str } from "@/lib/api-helpers";

type Ctx = { params: Promise<{ id: string }> };

/** Owner edit: metadata, usage description, status, and optional secret rotation (new numbers go straight to the vault). */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await readJson<Record<string, unknown>>(req);
    const method = updateMethod(id, {
      displayName: typeof body.displayName === "string" ? body.displayName : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      status: body.status === "AVAILABLE" || body.status === "DISABLED" ? body.status : undefined,
      cardholderName: typeof body.cardholderName === "string" ? body.cardholderName : undefined,
      accountHolderName: typeof body.accountHolderName === "string" ? body.accountHolderName : undefined,
      bankName: typeof body.bankName === "string" ? body.bankName : undefined,
      billing: body.billing && typeof body.billing === "object" ? (body.billing as Record<string, string>) : undefined,
      expirationMonth: body.expirationMonth ? Number(body.expirationMonth) : undefined,
      expirationYear: body.expirationYear ? Number(body.expirationYear) : undefined,
      accountType: body.accountType === "CHECKING" || body.accountType === "SAVINGS" ? body.accountType : undefined,
      cardNumber: str(body.cardNumber, 32) || undefined,
      cvv: typeof body.cvv === "string" ? str(body.cvv, 4) ?? "" : undefined,
      routingNumber: str(body.routingNumber, 20) || undefined,
      accountNumber: str(body.accountNumber, 32) || undefined,
    });
    return NextResponse.json({ method });
  } catch (err) {
    return jsonError(err);
  }
}

/** Owner only: deletion is never available to agents. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    deleteMethod(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
