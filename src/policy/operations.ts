import { readFileSync } from "node:fs";

export const OPERATION_NAMES = [
  "public.read",
  "public.search",
  "reservation.create",
  "reservation.cancel",
  "electronic-signature",
  "money.transfer",
  "payment",
] as const;

export type OperationName = (typeof OPERATION_NAMES)[number];
export type OperationDecision =
  "automatic" | "confirmation-required" | "prohibited";

export interface OperationsPolicy {
  schemaVersion: 1;
  timezone: "Asia/Seoul";
  hostDiskEncryption: {
    required: false;
    currentProfile: "unencrypted-wsl2";
  };
  actions: {
    automatic: OperationName[];
    confirmationRequired: OperationName[];
    prohibited: OperationName[];
  };
  kSkillUpdate: {
    localTime: "00:00";
    missedRun: "run-on-next-startup-once";
  };
  logs: {
    retentionDays: number;
    maximumBytes: number;
    excludeContent: string[];
  };
  backups: {
    schedule: "weekly";
    day: "sunday";
    localTime: "03:00";
    retentionCopies: number;
    include: string[];
    exclude: string[];
    destinationRequired: true;
  };
  failureAlerts: {
    target: "telegram-admin";
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return value as string[];
}

function actionArray(value: unknown, label: string): OperationName[] {
  const values = stringArray(value, label);
  if (values.some((item) => !OPERATION_NAMES.includes(item as OperationName))) {
    throw new Error(`${label} contains an unknown operation`);
  }
  return values as OperationName[];
}

export function parseOperationsPolicy(value: unknown): OperationsPolicy {
  const root = record(value, "Operations policy");
  exactKeys(
    root,
    [
      "schemaVersion",
      "timezone",
      "hostDiskEncryption",
      "actions",
      "kSkillUpdate",
      "logs",
      "backups",
      "failureAlerts",
    ],
    "Operations policy",
  );

  const disk = record(root.hostDiskEncryption, "Disk encryption policy");
  exactKeys(disk, ["required", "currentProfile"], "Disk encryption policy");
  const actions = record(root.actions, "Action policy");
  exactKeys(
    actions,
    ["automatic", "confirmationRequired", "prohibited"],
    "Action policy",
  );
  const updater = record(root.kSkillUpdate, "Updater policy");
  exactKeys(updater, ["localTime", "missedRun"], "Updater policy");
  const logs = record(root.logs, "Log policy");
  exactKeys(
    logs,
    ["retentionDays", "maximumBytes", "excludeContent"],
    "Log policy",
  );
  const backups = record(root.backups, "Backup policy");
  exactKeys(
    backups,
    [
      "schedule",
      "day",
      "localTime",
      "retentionCopies",
      "include",
      "exclude",
      "destinationRequired",
    ],
    "Backup policy",
  );
  const alerts = record(root.failureAlerts, "Failure alert policy");
  exactKeys(alerts, ["target"], "Failure alert policy");

  const automatic = actionArray(actions.automatic, "Automatic actions");
  const confirmationRequired = actionArray(
    actions.confirmationRequired,
    "Confirmation actions",
  );
  const prohibited = actionArray(actions.prohibited, "Prohibited actions");
  const classified = [...automatic, ...confirmationRequired, ...prohibited];
  if (
    classified.length !== OPERATION_NAMES.length ||
    new Set(classified).size !== OPERATION_NAMES.length
  ) {
    throw new Error("Every operation must have exactly one decision");
  }
  if (
    root.schemaVersion !== 1 ||
    root.timezone !== "Asia/Seoul" ||
    disk.required !== false ||
    disk.currentProfile !== "unencrypted-wsl2" ||
    updater.localTime !== "00:00" ||
    updater.missedRun !== "run-on-next-startup-once" ||
    !Number.isSafeInteger(logs.retentionDays) ||
    (logs.retentionDays as number) < 1 ||
    !Number.isSafeInteger(logs.maximumBytes) ||
    (logs.maximumBytes as number) < 1 ||
    backups.schedule !== "weekly" ||
    backups.day !== "sunday" ||
    backups.localTime !== "03:00" ||
    !Number.isSafeInteger(backups.retentionCopies) ||
    (backups.retentionCopies as number) < 1 ||
    backups.destinationRequired !== true ||
    alerts.target !== "telegram-admin"
  ) {
    throw new Error("Operations policy contains unsupported values");
  }

  return {
    schemaVersion: 1,
    timezone: "Asia/Seoul",
    hostDiskEncryption: {
      required: false,
      currentProfile: "unencrypted-wsl2",
    },
    actions: { automatic, confirmationRequired, prohibited },
    kSkillUpdate: {
      localTime: "00:00",
      missedRun: "run-on-next-startup-once",
    },
    logs: {
      retentionDays: logs.retentionDays as number,
      maximumBytes: logs.maximumBytes as number,
      excludeContent: stringArray(logs.excludeContent, "Log exclusions"),
    },
    backups: {
      schedule: "weekly",
      day: "sunday",
      localTime: "03:00",
      retentionCopies: backups.retentionCopies as number,
      include: stringArray(backups.include, "Backup includes"),
      exclude: stringArray(backups.exclude, "Backup exclusions"),
      destinationRequired: true,
    },
    failureAlerts: { target: "telegram-admin" },
  };
}

export function loadOperationsPolicy(path: string): OperationsPolicy {
  return parseOperationsPolicy(
    JSON.parse(readFileSync(path, "utf8")) as unknown,
  );
}

export function classifyOperation(
  policy: OperationsPolicy,
  operation: OperationName,
): OperationDecision {
  if (policy.actions.automatic.includes(operation)) {
    return "automatic";
  }
  if (policy.actions.confirmationRequired.includes(operation)) {
    return "confirmation-required";
  }
  return "prohibited";
}
