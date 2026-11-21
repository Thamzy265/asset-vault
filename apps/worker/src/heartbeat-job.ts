export const HEARTBEAT_QUEUE = "heartbeat";
/** Every minute. The last run time is what the health endpoint reports. */
export const HEARTBEAT_CRON = "* * * * *";

export type HeartbeatDeps = {
  record: (at: Date) => Promise<void>;
  now: () => Date;
  log: (msg: string, fields: Record<string, unknown>) => void;
};

/** Records the run time. A rejected write fails the job so pg-boss retries it. */
export async function runHeartbeat(deps: HeartbeatDeps): Promise<void> {
  const at = deps.now();
  await deps.record(at);
  deps.log("heartbeat", { at: at.toISOString() });
}
