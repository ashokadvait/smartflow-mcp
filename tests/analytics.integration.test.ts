import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  getAgentPerformance,
  getConversionFunnel,
  getDailyCallReport,
  searchCalls,
} from "../src/analytics/analytics.service.js";
import { closeDb, db } from "../src/db/client.js";
import { tenants } from "../src/db/schema/index.js";
import { upsertNormalizedCall } from "../src/services/sync.service.js";
import { getDayBoundsUtc } from "../src/utils/dates.js";

describe("PostgreSQL ingestion & deterministic analytics integration", () => {
  let testTenantId: string;

  afterAll(async () => {
    if (testTenantId) {
      await db.delete(tenants).where(eq(tenants.id, testTenantId));
    }
    await closeDb();
  });

  it("upserts calls idempotently and computes accurate SQL daily & agent metrics", async () => {
    const [tenant] = await db
      .insert(tenants)
      .values({ name: `test-tenant-${Date.now()}`, timezone: "Asia/Kolkata" })
      .returning();
    testTenantId = tenant!.id;

    const callDate = new Date("2026-11-20T05:00:00.000Z"); // 10:30 IST

    // Insert call 1 twice to verify idempotency (no duplicate)
    const first = await upsertNormalizedCall(testTenantId, {
      externalId: "call-ext-1",
      agentExternalId: "agent-1",
      agentName: "Ananya",
      phone: "919876543210",
      status: "answered",
      direction: "outbound",
      startedAt: callDate,
      durationSeconds: 130,
      answeredSeconds: 120,
      recordingUrl: "https://cloudphone.tatateleservices.com/file/recording?callId=1&token=abc",
    });
    const duplicate = await upsertNormalizedCall(testTenantId, {
      externalId: "call-ext-1",
      agentExternalId: "agent-1",
      agentName: "Ananya",
      phone: "919876543210",
      status: "answered",
      direction: "outbound",
      startedAt: callDate,
      durationSeconds: 130,
      answeredSeconds: 120,
    });
    expect(first.isNew).toBe(true);
    expect(duplicate.isNew).toBe(false);
    expect(duplicate.callId).toBe(first.callId);

    // Insert missed call 2 for the same lead
    await upsertNormalizedCall(testTenantId, {
      externalId: "call-ext-2",
      agentExternalId: "agent-1",
      agentName: "Ananya",
      phone: "919876543210",
      status: "missed",
      direction: "outbound",
      startedAt: new Date("2026-11-20T06:00:00.000Z"),
      durationSeconds: 15,
      answeredSeconds: 0,
    });

    const report = await getDailyCallReport({
      tenantId: testTenantId,
      date: "2026-11-20",
      timezone: "Asia/Kolkata",
    });

    expect(report.callActivity.totalCalls).toBe(2);
    expect(report.callActivity.answeredCalls).toBe(1);
    expect(report.callActivity.missedCalls).toBe(1);
    expect(report.callActivity.uniqueLeads).toBe(1);
    expect(report.callActivity.avgTalkDurationSeconds).toBe(120);
    expect(report.completeness.withRecording).toBe(1);
    expect(report.completeness.analysisCompletenessPct).toBe(0);

    const { from, to } = getDayBoundsUtc("2026-11-20", "Asia/Kolkata");
    const perf = await getAgentPerformance({ tenantId: testTenantId, from, to });
    expect(perf.agents[0]?.name).toBe("Ananya");
    expect(perf.agents[0]?.totalCalls).toBe(2);
    expect(perf.agents[0]?.connectedCalls).toBe(1);
    expect(perf.agents[0]?.uniqueLeads).toBe(1);

    const search = await searchCalls({ tenantId: testTenantId, from, to });
    expect(search.count).toBe(2);
    expect(search.calls[0]?.leadPhoneMasked).toBe("********3210");

    const funnel = await getConversionFunnel({ tenantId: testTenantId, from, to });
    expect(funnel.leadReach.attemptedUniqueLeads).toBe(1);
    expect(funnel.leadReach.connectedUniqueLeads).toBe(1);
    expect(funnel.leadReach.leadContactRatePct).toBe(100);
  });
});

