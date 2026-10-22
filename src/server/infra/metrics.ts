import { getRedis } from "./redis";

const buckets = [50, 100, 300, 500, 1000, 2000, 5000, 10000];
export async function recordSnapshotSize(bytes: number) {
  const { control } = getRedis(); if (control.status !== "ready") return;
  await control.multi().hincrby("ds:metrics:snapshots", "bytes", bytes).hincrby("ds:metrics:snapshots", "count", 1).exec();
}
export async function recordRequest(event: string, code: string, elapsed: number) {
  const { control } = getRedis(); if (control.status !== "ready") return;
  const batch = control.multi().hincrby("ds:metrics", `${event}:${code}:count`, 1)
    .hincrby("ds:metrics", `${event}:duration:sum`, elapsed).hincrby("ds:metrics", `${event}:duration:count`, 1);
  for (const boundary of buckets) if (elapsed <= boundary) batch.hincrby("ds:metrics", `${event}:duration:${boundary}`, 1);
  await batch.exec();
}
export async function renderMetrics() {
  const { control } = getRedis(); const values = await control.hgetall("ds:metrics");
  const output = ["# TYPE deepsearch_requests_total counter", "# TYPE deepsearch_request_duration_seconds histogram"];
  for (const [key, value] of Object.entries(values)) {
    const [event, code, metric] = key.split(":");
    if (code !== "duration" && metric === "count") output.push(`deepsearch_requests_total{operation="${event}",code="${code}"} ${value}`);
  }
  const events = new Set(Object.keys(values).map(key => key.split(":")[0]));
  for (const event of events) {
    for (const boundary of buckets) output.push(`deepsearch_request_duration_seconds_bucket{operation="${event}",le="${boundary / 1000}"} ${values[`${event}:duration:${boundary}`] ?? 0}`);
    output.push(`deepsearch_request_duration_seconds_bucket{operation="${event}",le="+Inf"} ${values[`${event}:duration:count`] ?? 0}`);
    output.push(`deepsearch_request_duration_seconds_sum{operation="${event}"} ${Number(values[`${event}:duration:sum`] ?? 0) / 1000}`);
    output.push(`deepsearch_request_duration_seconds_count{operation="${event}"} ${values[`${event}:duration:count`] ?? 0}`);
  }
  const sizes = await control.hgetall("ds:metrics:snapshots");
  output.push("# TYPE deepsearch_snapshot_bytes summary", `deepsearch_snapshot_bytes_sum ${sizes.bytes ?? 0}`, `deepsearch_snapshot_bytes_count ${sizes.count ?? 0}`);
  return output.join("\n") + "\n";
}
