import { describe, expect, it } from "vitest";
import { CLI_VERSION, createProgram } from "../src/index.js";

describe("@batuta/cli", () => {
  it("expone la versión de la CLI sincronizada con el núcleo", () => {
    expect(CLI_VERSION).toBe("0.1.0");
    const program = createProgram();
    expect(program.version()).toBe("0.1.0");
  });

  it("responde con la versión al pasar la opción --version", () => {
    const program = createProgram();
    program.exitOverride();

    let output = "";
    program.configureOutput({
      writeOut: (str) => {
        output += str;
      },
    });

    expect(() => {
      program.parse(["node", "batuta", "--version"]);
    }).toThrow();

    expect(output.trim()).toBe("0.1.0");
  });
});
