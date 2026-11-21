import { closeDb } from "../db/client.js";
import { analyzeCallTranscript } from "../pipeline/analysis.pipeline.js";
import { transcribeCallRecording } from "../pipeline/transcription.pipeline.js";

async function main() {
  const callId = process.argv[2];
  if (!callId) {
    console.error("Usage: npm run process:call -- <call-uuid>");
    process.exit(1);
  }

  console.log(`1/2 Downloading & transcribing call ${callId}...`);
  const transcript = await transcribeCallRecording(callId);
  console.log(
    `    Transcript saved (${transcript.id}) | language=${transcript.language ?? "unknown"} | quality=${transcript.qualityFlag}`
  );

  console.log(`2/2 Running AI analysis for call ${callId}...`);
  const analysis = await analyzeCallTranscript(callId);
  console.log(
    `    Analysis saved (${analysis.id}) | outcome=${analysis.callOutcome} | temp=${analysis.leadTemperature} | qa=${analysis.qualityScore}/100`
  );
}

main()
  .catch((err) => {
    console.error("Process call failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });

