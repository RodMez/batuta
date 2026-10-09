#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { CORE_VERSION } from "@batuta/core";

export const CLI_VERSION = CORE_VERSION;

export function createProgram(version: string = CLI_VERSION): Command {
  const program = new Command();

  program
    .name("batuta")
    .description("Orquestador de agentes de IA")
    .version(version, "-v, --version", "Muestra la versión actual de Batuta");

  return program;
}

export function runCli(argv: string[] = process.argv): void {
  const program = createProgram();
  program.parse(argv);
}

const currentFilePath = fileURLToPath(import.meta.url);
const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (executedFilePath && path.resolve(currentFilePath) === executedFilePath) {
  runCli();
}
