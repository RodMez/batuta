import { describe, expect, it } from "vitest";
import { createProgram } from "../src/index.js";

describe("ayuda en español", () => {
  it("el programa muestra Uso y Comandos en español", () => {
    const program = createProgram();
    const ayuda = program.helpInformation();
    expect(ayuda).toContain("Uso:");
    expect(ayuda).toContain("Comandos:");
    expect(ayuda).not.toContain("Usage:");
    expect(ayuda).not.toContain("Commands:");
  });

  it("cada comando muestra Uso, Argumentos u Opciones en español", () => {
    const program = createProgram();
    for (const nombre of ["run", "status", "approve", "answer", "resume", "abort", "doctor"]) {
      const cmd = program.commands.find((c) => c.name() === nombre);
      expect(cmd, `existe el comando ${nombre}`).toBeDefined();
      const ayuda = cmd!.helpInformation();
      expect(ayuda).toContain("Uso:");
      expect(ayuda).not.toContain("Usage:");
      expect(ayuda).not.toContain("Options:");
      expect(ayuda).not.toContain("Arguments:");
      expect(ayuda).not.toContain("display help for command");
    }
  });

  it("las descripciones están en español", () => {
    const program = createProgram();
    const run = program.commands.find((c) => c.name() === "run")!;
    expect(run.description()).toMatch(/ejecución/i);
    const abort = program.commands.find((c) => c.name() === "abort")!;
    expect(abort.description()).toMatch(/Aborta/);
  });
});
