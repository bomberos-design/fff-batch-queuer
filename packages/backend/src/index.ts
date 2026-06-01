import app from "./api";
import { processDlqMessage, processJobMessage } from "./consumer";
import { runDailyHealthCheck } from "./healthCheck";
import { recoverOrphanedRunningJobs } from "./recovery";
import { QUEUE_NAMES } from "./types";
import type { Env, JobMessage } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    ctx.waitUntil(recoverOrphanedRunningJobs(env));
    return app.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      recoverOrphanedRunningJobs(env, { force: true }).catch((err) => {
        console.error("[recovery] scheduled recovery failed", err);
      }),
    );
    if (controller.cron === "0 8 * * *") {
      ctx.waitUntil(
        runDailyHealthCheck(env).catch((err) => {
          console.error("[health] daily check failed", err);
        }),
      );
    }
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    await recoverOrphanedRunningJobs(env);
    const isDlq = batch.queue === QUEUE_NAMES.dlq;
    for (const msg of batch.messages) {
      try {
        if (isDlq) {
          await processDlqMessage(msg, env);
        } else {
          await processJobMessage(msg, env);
        }
      } catch (err) {
        console.error(
          `[queue] unexpected error processing ${msg.id} on ${batch.queue}`,
          err,
        );
        msg.retry({ delaySeconds: 30 });
      }
    }
  },
} satisfies ExportedHandler<Env, JobMessage>;
