import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";

let sharedConnection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!sharedConnection) {
    sharedConnection = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
  }
  return sharedConnection;
}

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: "exponential" as const,
    delay: 2000,
  },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 1000 },
};

export function createQueues() {
  const connection = getRedisConnection();
  return {
    syncQueue: new Queue("smartflow-sync", { connection, defaultJobOptions }),
    recordingQueue: new Queue("recording", { connection, defaultJobOptions }),
    transcriptionQueue: new Queue("transcription", { connection, defaultJobOptions }),
    analysisQueue: new Queue("analysis", { connection, defaultJobOptions }),
  };
}

export async function closeRedis(): Promise<void> {
  if (sharedConnection) {
    await sharedConnection.quit();
    sharedConnection = null;
  }
}

