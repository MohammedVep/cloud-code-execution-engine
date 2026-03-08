import { Queue } from "bullmq";
import { Redis } from "ioredis";

const requireEnv = (key) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const redisUrl = new URL(requireEnv("REDIS_URL"));
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || "6379"),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  db: redisUrl.pathname && redisUrl.pathname !== "/" ? Number(redisUrl.pathname.slice(1)) : 0,
  maxRetriesPerRequest: null,
  tls: redisUrl.protocol === "rediss:" ? {} : undefined
};

const jobQueueName = process.env.JOB_QUEUE_NAME || "code-jobs";
const dlqQueueName = process.env.DLQ_QUEUE_NAME || "code-jobs-dlq";
const attempts = toInt(process.env.QUEUE_JOB_ATTEMPTS, 3);
const backoffMs = toInt(process.env.QUEUE_RETRY_BACKOFF_MS, 1000);
const ttlSeconds = toInt(process.env.JOB_TTL_SECONDS, 86400);
const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const batchSize = Math.max(1, toInt(process.env.DLQ_BATCH_SIZE, 50));

const redis = new Redis(connection);
const dlq = new Queue(dlqQueueName, { connection });
const main = new Queue(jobQueueName, { connection });

const fetchJobs = async () => {
  const jobs = [];
  const states = ["failed", "waiting", "delayed", "paused"];
  for (const state of states) {
    let start = 0;
    while (true) {
      const batch = await dlq.getJobs([state], start, start + batchSize - 1, true);
      if (batch.length === 0) {
        break;
      }
      jobs.push(...batch);
      if (batch.length < batchSize) {
        break;
      }
      start += batchSize;
    }
  }
  return jobs;
};

const run = async () => {
  const startedAt = Date.now();
  const jobs = await fetchJobs();

  let recovered = 0;
  let skipped = 0;
  let failed = 0;

  for (const job of jobs) {
    const payload = job?.data;
    if (!payload || !payload.jobId) {
      skipped += 1;
      continue;
    }

    const targetJobId = `${payload.jobId}-replay-${Date.now()}`;
    if (dryRun) {
      recovered += 1;
      continue;
    }

    try {
      await main.add(targetJobId, payload, {
        jobId: targetJobId,
        attempts,
        backoff: { type: "custom", delay: backoffMs },
        removeOnComplete: { age: ttlSeconds },
        removeOnFail: { age: ttlSeconds }
      });
      await job.remove();
      recovered += 1;
    } catch (error) {
      failed += 1;
      console.error("dlq_replay_failed", { jobId: payload.jobId, error: error?.message || error });
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.table([
    {
      dlqQueue: dlqQueueName,
      mainQueue: jobQueueName,
      totalSeen: jobs.length,
      recovered,
      skipped,
      failed,
      dryRun,
      elapsedMs
    }
  ]);
};

run()
  .catch((error) => {
    console.error("dlq_replay_failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await dlq.close();
    await main.close();
    redis.disconnect();
  });
