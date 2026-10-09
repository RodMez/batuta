import { describe, expect, it } from "vitest";
import {
  AgentInputSchema,
  AgentOutputJsonSchema,
  AgentOutputSchema,
  AGENT_STATUSES,
  parseAgentInput,
  parseAgentOutput,
} from "../src/index.js";

const INPUT_VALIDA = {
  task_id: "TASK-102",
  agent_role: "software-engineer",
  spec_path: ".batuta/runs/RUN-2026-10-09-001/spec.md",
  allowed_files: ["src/services/user.py"],
  budget_limit_usd: 1.5,
  max_steps: 15,
} as const;

const OUTPUT_VALIDA = {
  status: "SUCCESS",
  summary: "Implementada la subtarea con pruebas",
  files_modified: ["src/services/user.py", "tests/test_user.py"],
  reported_checks: [{ command: "npm test", exit_code: 0 }],
  continuation_notes: "",
  blocking_question: "",
} as const;

describe("contrato de agentes (CA-1, CA-4)", () => {
  it("expone los esquemas desde @batuta/core", () => {
    expect(AgentInputSchema).toBeDefined();
    expect(AgentOutputSchema).toBeDefined();
  });

  it("acepta una entrada válida de la sección 5", () => {
    expect(parseAgentInput({ ...INPUT_VALIDA })).toMatchObject({
      task_id: "TASK-102",
      agent_role: "software-engineer",
    });
  });

  it("acepta una salida válida", () => {
    expect(parseAgentOutput({ ...OUTPUT_VALIDA }).status).toBe("SUCCESS");
  });

  it("acepta los cuatro estados de salida", () => {
    expect(AGENT_STATUSES).toEqual([
      "SUCCESS",
      "FAILED",
      "NEEDS_CONTINUATION",
      "NEEDS_INPUT",
    ]);
    for (const status of AGENT_STATUSES) {
      expect(
        parseAgentOutput({ ...OUTPUT_VALIDA, status }).status,
      ).toBe(status);
    }
  });

  it("rechaza un estado desconocido indicando la ruta", () => {
    expect(() =>
      parseAgentOutput({ ...OUTPUT_VALIDA, status: "DESCONOCIDO" }),
    ).toThrow(/status/);
  });

  it("rechaza un campo faltante indicando la ruta", () => {
    const { summary: _omit, ...sinSummary } = OUTPUT_VALIDA;
    expect(_omit).toBe("Implementada la subtarea con pruebas");
    expect(() => parseAgentOutput(sinSummary)).toThrow(/summary/);
  });

  it("rechaza un campo desconocido", () => {
    expect(() =>
      parseAgentOutput({ ...OUTPUT_VALIDA, campo_extra: 1 }),
    ).toThrow(/campo_extra/);
  });
});

describe("JSON Schema de AgentOutput (CA-6)", () => {
  it("incluye los campos obligatorios y los cuatro estados", () => {
    const schema = AgentOutputJsonSchema as {
      required?: unknown;
      properties?: Record<string, { enum?: unknown } | undefined>;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "status",
        "summary",
        "files_modified",
        "reported_checks",
        "continuation_notes",
        "blocking_question",
      ]),
    );
    expect(schema.properties?.["status"]?.enum).toEqual(
      expect.arrayContaining([
        "SUCCESS",
        "FAILED",
        "NEEDS_CONTINUATION",
        "NEEDS_INPUT",
      ]),
    );
  });
});
