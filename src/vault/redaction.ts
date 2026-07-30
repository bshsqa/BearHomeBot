const REDACTION = "[REDACTED]";

const STRUCTURED_SECRET_PATTERNS = [
  /\b(BEARHOMEBOT_TELEGRAM_TOKEN|KSKILL_KTX_ID|KSKILL_KTX_PASSWORD)\s*=\s*[^\s]+/giu,
  /\b[0-9]{5,12}:[A-Za-z0-9_-]{20,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/giu,
];

function derivedSecretForms(secret: string): string[] {
  const forms = new Set<string>();
  if (secret) {
    forms.add(secret);
    forms.add(Buffer.from(secret, "utf8").toString("base64"));
    try {
      forms.add(encodeURIComponent(secret));
    } catch {
      // The literal and base64 forms still apply.
    }
  }
  return [...forms].filter((value) => value.length > 0);
}

export function redactText(
  text: string,
  secrets: Iterable<string | Buffer> = [],
): string {
  let redacted = text;
  const forms = [...secrets]
    .flatMap((secret) =>
      derivedSecretForms(
        Buffer.isBuffer(secret) ? secret.toString("utf8") : secret,
      ),
    )
    .sort((left, right) => right.length - left.length);

  for (const form of forms) {
    redacted = redacted.split(form).join(REDACTION);
  }
  for (const pattern of STRUCTURED_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, key?: string) =>
      key ? `${key}=${REDACTION}` : REDACTION,
    );
  }
  return redacted;
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactText(error.message);
  }
  return "Unknown error";
}
