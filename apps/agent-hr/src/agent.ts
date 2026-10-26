import {
  AppErrorCode,
  createAgentCard,
  createAgentServer,
  hrSectionSchema,
  internalError,
  parseParams,
  resolveDuration,
  sectionCallParamsSchema,
  type HrSection,
  type SectionCallParams,
  type SectionEnvelope,
} from "@travel/shared";
import type { FastifyInstance } from "fastify";
import { normalizeEmployeeId, remainingDays } from "./catalog";
import { openHrCatalog, type HrCatalogHandle } from "./db";

const VERSION = "0.1.0";

/** Canonical employee number: `E` + 4 digits (`E0001`). */
export const EMPLOYEE_ID_PATTERN = /^E\d{4}$/;

/**
 * Leave-status check (§17.5). No model call: the trip length comes from the same
 * shared duration helper the orchestrator's day grid and the budget agent use, and
 * the verdict is arithmetic over the seeded balance.
 *
 * Unresolvable identifiers and an unusable database are reported as a failed section
 * (never as a thrown process) so `warnOnFailure` can repeat the reason in the
 * itinerary summary while the plan itself completes.
 */
function hrHandler(catalog: HrCatalogHandle) {
  return async (raw: unknown): Promise<{ sectionResult: SectionEnvelope }> => {
    const params = parseParams(sectionCallParamsSchema, raw) as SectionCallParams;
    const employeeId = params.input?.employeeId?.trim();
    const employeeName = params.input?.employeeName?.trim();

    if (!employeeId && !employeeName) {
      throw internalError(
        AppErrorCode.InvalidParams,
        "hr agent requires input.employeeId (or input.employeeName)",
        false,
      );
    }
    if (employeeId && !EMPLOYEE_ID_PATTERN.test(normalizeEmployeeId(employeeId))) {
      throw internalError(
        AppErrorCode.InvalidParams,
        `invalid employeeId "${employeeId}" — expected format E0001`,
        false,
      );
    }

    const outcome = catalog.lookup(employeeId, employeeName);
    if (outcome.status !== "found") {
      throw internalError(AppErrorCode.InvalidParams, outcome.detail, false, {
        employeeId: employeeId ?? normalizeEmployeeId(employeeName ?? ""),
        employeeName,
      });
    }

    const employee = outcome.employee;

    // Same shared trip-length source as the day grid (§17.1) and the budget card
    // (§17.4): parsed dates → input dates → duration in the query → 3 with a note.
    const { days, source } = resolveDuration(params.input ?? {}, params.sharedContext);
    const remaining = remainingDays(employee);
    const compliant = remaining >= days;
    const balanceAfter = remaining - days;

    const disclaimers: string[] = [];
    if (source === "default") {
      disclaimers.push(
        `No travel dates or stated duration were provided; testing a ${days}-day trip.`,
      );
    }
    if (employeeName && employeeId && employeeName.trim() !== employee.name) {
      disclaimers.push(
        `Matched by employee id; the supplied name "${employeeName}" was not used for the lookup.`,
      );
    }
    disclaimers.push(
      "Leave status is checked against the stored balance only; no leave is requested or booked.",
    );

    const data = hrSectionSchema.parse({
      employeeId: employee.employeeId,
      employeeName: employee.name,
      department: employee.department,
      entitlementDays: employee.entitlementDays,
      usedDays: employee.usedDays,
      remainingDays: remaining,
      tripDays: days,
      balanceAfter,
      compliant,
      verdict: compliant ? "compliant" : "insufficient-balance",
      disclaimers,
    } satisfies HrSection);

    return {
      sectionResult: { key: params.section ?? "hr", status: "completed", data },
    };
  };
}

export async function buildHrServer(
  opts: { logger?: boolean; dbPath?: string } = {},
): Promise<FastifyInstance> {
  const port = Number(process.env.AGENT_HR_PORT ?? 8004);

  // Never throws: an unusable database means a degraded /health and a failed
  // section, not a dead process (`concurrently -k` would kill the whole stack).
  const catalog = openHrCatalog(opts.dbPath);
  if (!catalog.usable) console.error(`[agent-hr] employee database unusable: ${catalog.error}`);

  const card = createAgentCard({
    name: "hr",
    description:
      "Checks an employee's leave balance against the planned trip dates and reports whether the vacation is within allowance.",
    version: VERSION,
    baseUrl: `http://localhost:${port}`,
    skills: [
      {
        id: "leave-status",
        name: "Leave Status Check",
        description:
          "Compares the trip length with the employee's remaining leave balance and returns a compliant / insufficient verdict.",
        tags: ["hr", "leave", "vacation", "balance", "compliance"],
        examples: ["Can E0001 take 5 days off for this trip?"],
      },
    ],
  });

  const app = await createAgentServer({
    card,
    handlers: { "message/send": hrHandler(catalog) },
    logger: opts.logger ?? true,
    health: () => ({ status: catalog.usable ? "ok" : "degraded" }),
  });
  app.addHook("onClose", async () => catalog.close());
  return app;
}
