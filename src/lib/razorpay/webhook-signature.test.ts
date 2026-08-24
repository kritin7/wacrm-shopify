import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyRazorpayWebhookSignature } from "./webhook-signature";

const SECRET = "test_webhook_secret";

function signedHeader(body: string, secret: string = SECRET): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyRazorpayWebhookSignature", () => {
  it("accepts a request signed with the correct secret", () => {
    const body = JSON.stringify({ event: "checkout.abandoned" });
    expect(
      verifyRazorpayWebhookSignature(body, signedHeader(body), SECRET),
    ).toBe(true);
  });

  it("rejects a signature computed with a different secret", () => {
    const body = "{}";
    expect(
      verifyRazorpayWebhookSignature(
        body,
        signedHeader(body, "wrong_secret"),
        SECRET,
      ),
    ).toBe(false);
  });

  it("rejects when the body has been tampered with after signing", () => {
    const original = '{"phone":"+919999999999"}';
    const header = signedHeader(original);
    const tampered = '{"phone":"+911111111111"}';
    expect(verifyRazorpayWebhookSignature(tampered, header, SECRET)).toBe(
      false,
    );
  });

  it("rejects a missing header", () => {
    expect(verifyRazorpayWebhookSignature("anything", null, SECRET)).toBe(
      false,
    );
  });

  it("rejects a header carrying a sha256= prefix (Meta's scheme, not Razorpay's)", () => {
    const body = "{}";
    const hex = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
    expect(
      verifyRazorpayWebhookSignature(body, `sha256=${hex}`, SECRET),
    ).toBe(false);
  });

  it("rejects a base64-shaped header (Shopify's scheme, not Razorpay's)", () => {
    const body = "{}";
    const base64 = crypto
      .createHmac("sha256", SECRET)
      .update(body)
      .digest("base64");
    expect(verifyRazorpayWebhookSignature(body, base64, SECRET)).toBe(false);
  });

  it("rejects a header of the wrong length without throwing", () => {
    // timingSafeEqual would throw on length mismatch — the guard inside
    // the verifier should catch this and return false instead.
    expect(verifyRazorpayWebhookSignature("{}", "abcd", SECRET)).toBe(false);
  });
});
