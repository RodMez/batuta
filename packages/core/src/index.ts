export const CORE_VERSION = "0.1.0";

export interface CoreInfo {
  name: string;
  version: string;
}

export function getCoreInfo(): CoreInfo {
  return {
    name: "@batuta/core",
    version: CORE_VERSION,
  };
}

export { AgentInputSchema } from "./agentContract.js";
export type { AgentInput } from "./agentContract.js";
export {
  AgentOutputJsonSchema,
  AgentOutputSchema,
  AgentRoleSchema,
  AgentStatusSchema,
  AGENT_ROLES,
  AGENT_STATUSES,
  parseAgentInput,
  parseAgentOutput,
  ReportedCheckSchema,
} from "./agentContract.js";
export type {
  AgentOutput,
  AgentRole,
  AgentStatus,
  ReportedCheck,
} from "./agentContract.js";
export {
  BatutaConfigSchema,
  loadBatutaConfig,
  parseBatutaConfig,
  parseBatutaConfigYaml,
} from "./config.js";
export type { BatutaConfig, Gate } from "./config.js";
export {
  CheckpointSchema,
  indiceDeCheckpoint,
  nombreCheckpoint,
  parseCheckpoint,
} from "./checkpoints.js";
export type { Checkpoint } from "./checkpoints.js";
export { leerRegistro, leerTextoRegistro, prefijoCompleto } from "./eventLog.js";
export type { LecturaRegistro } from "./eventLog.js";
export {
  MODELO_CAPTURA_POR_DEFECTO,
  VARIABLES_MODELO_CAPTURA,
  crearContextoCaptura,
  crearInputCaptura,
  modeloCapturaDesdeEntorno,
} from "./captura.js";
export {
  EVENT_TYPES,
  EventSchema,
  EventTypeSchema,
  parseEvent,
  parseEventLine,
  serializeEvent,
} from "./events.js";
export type { BatutaEvent, EventType } from "./events.js";
export {
  PlanSchema,
  parsePlan,
  SubtaskSchema,
  TaskComplexitySchema,
  TASK_COMPLEXITIES,
} from "./plan.js";
export type { Plan, Subtask, TaskComplexity } from "./plan.js";
export {
  AgenteCompletadoPayloadSchema,
  AprobacionPayloadSchema,
  EntradaRecibidaPayloadSchema,
  LimitePayloadSchema,
  applyEvent,
  esEstadoTerminal,
  estadoInicial,
  rebuildState,
} from "./reducer.js";
export type {
  AgenteCompletadoPayload,
  AprobacionPayload,
  EntradaRecibidaPayload,
  LimitePayload,
} from "./reducer.js";
export {
  dirCheckpoints,
  dirLogs,
  dirRun,
  dirRuns,
  generarRunId,
  InfoBloqueoSchema,
  parsearBloqueo,
  RunIdSchema,
  RunStore,
  rutaBloqueoRun,
  rutaEstado,
  rutaEventos,
} from "./runStore.js";
export type { InfoBloqueo, NuevoEvento, ResultadoRestore } from "./runStore.js";
export {
  detalleError,
  esNoEncontrado,
  existeProceso,
  relojSistema,
  sistemaArchivosNode,
} from "./sistema.js";
export type { Reloj, SistemaArchivos } from "./sistema.js";
export {
  PUERTAS,
  PuertaSchema,
  RUN_STATUSES,
  parseRunState,
  RunStateSchema,
  RunStatusSchema,
} from "./state.js";
export type { Puerta, RunState, RunStatus } from "./state.js";
export { formatZodError, stringifyIssuePath } from "./validation.js";
export {
  BufferTruncado,
  construirEntornoLimpio,
  EjecutorComandosReal,
  matarArbolProcesos,
  separarComandoYArgumentos,
  VARIABLES_ENTORNO_PERMITIDAS,
} from "./commandRunner.js";
export type {
  EjecutorComandos,
  OpcionesEjecucionArgs,
  OpcionesEjecucionComando,
  ResultadoComando,
} from "./commandRunner.js";
export {
  crearPayloadGate,
  ejecutarGates,
  GateEjecutadoPayloadSchema,
  InformeGatesSchema,
  ResultadoGateSchema,
} from "./gatesRunner.js";
export type {
  GateEjecutadoPayload,
  InformeGates,
  OpcionesEjecucionGates,
  ResultadoGate,
} from "./gatesRunner.js";
export {
  coincideRutaProhibida,
  detectarSecretoEnLinea,
  evaluarDiff,
  normalizarRutaDiff,
  ofuscarSecretos,
} from "./diffPolicy.js";
export type {
  CambioArchivo,
  PoliticaDiff,
  TipoViolacionDiff,
  ViolacionDiff,
} from "./diffPolicy.js";
export {
  compararVersiones,
  esArchivoBinario,
  IDENTIDAD_BATUTA_POR_DEFECTO,
  ModuloGitReal,
  parsearLineasAnadidasDiff,
  parsearNumstatZ,
  parsearWorktreesPorcelain,
  VERSION_MINIMA_GIT,
} from "./git.js";
export type {
  InfoComprobacionesPrevias,
  InfoWorktree,
  ModuloGit,
  OpcionesCrearWorktree,
  OpcionesListarCambios,
  ResultadoCommitSubtarea,
  WorktreeListado,
  WorktreesHuerfanos,
} from "./git.js";
export {
  INFORME_FALLO_MAX_CHARS,
  INFORME_FALLO_MAX_LINEAS,
  firmaFallo,
  recortarInformeFallo,
} from "./informeFallo.js";
export type { FalloEvaluacion } from "./informeFallo.js";
export { listarEjecuciones } from "./ejecuciones.js";
export { NotificadorNulo } from "./notificador.js";
export {
  GuionLlamadaSchema,
  GuionSimuladoSchema,
  parseGuion,
  parseGuionJson,
  RunnerGuionado,
} from "./guionRunner.js";
export type { GuionLlamada, GuionSimulado } from "./guionRunner.js";
export type { Aviso, Notificador, TipoAviso } from "./notificador.js";
export { seleccionarModelo } from "./seleccionModelo.js";
export type { DecisionModelo } from "./seleccionModelo.js";
export { MotorFlujo } from "./motor.js";
export { hashContenido } from "./motorTipos.js";
export type {
  DependenciasMotor,
  OpcionesIniciar,
  PasoSiguiente,
  ProgresoMotor,
  ProgresoSubtarea,
  ResultadoMotor,
} from "./motorTipos.js";
export { siguientePaso, progresoInicial } from "./motorDecision.js";
export { construirPrompt, describirSubtarea } from "./motorPrompts.js";
export {
  comprobarLimites,
  emitirAdvertenciaCostos,
  fallarEjecucion,
  registrarUso,
} from "./motorLimites.js";
export {
  aprobarPuerta,
  limpiarWorktree,
  rechazarPuerta,
  revisarHashes,
  solicitarAprobacion,
  textoSolicitud,
} from "./motorAprobaciones.js";
export {
  decidirRolReintento,
  ejecutarSubtarea,
  evaluarExito,
  registrarFalloIntento,
} from "./motorSubtareas.js";
export { generarCierre, textoResumen } from "./motorResumen.js";
export {
  dirInformes,
  guardarProgreso,
  leerConfigRun,
  leerProgreso,
  leerReglasRepo,
  rutaConfig,
  rutaEspera,
  rutaMotor,
  rutaPlan,
  rutaResumen,
  rutaSolicitud,
  rutaSpec,
} from "./motorRutas.js";
export {
  calcularCostoEstimado,
  cargarPlantillaPrompt,
  ClaudeCodeRunner,
  construirInvocacionClaudeCode,
  FakeRunner,
  MotivoFalloAgenteSchema,
  parsearSalidaClaudeCode,
  verificarPreflightClaudeCode,
} from "./agentRunner.js";
export type {
  AgentCallContext,
  AgentRunner,
  AgentRunResult,
  CostoEstimado,
  InvocacionClaudeCodeParams,
  LimitesLlamada,
  MotivoFalloAgente,
  PermisosRol,
  UsoAgente,
} from "./agentRunner.js";
export {
  AntigravityRunner,
  esWorktreeValido,
  VARIABLES_ENTORNO_AGY,
} from "./antigravityRunner.js";
export type {
  AntigravityRunnerConfig,
  AntigravityRunnerDeps,
} from "./antigravityRunner.js";
export {
  BucketUsoSchema,
  CuotaManager,
  DatosUsoSchema,
  evaluarCuota,
  GrupoUsoSchema,
  obtenerBucketsParaModelo,
  parsearRespuestaUso,
  RespuestaUsageAgySchema,
} from "./cuotaManager.js";
export type {
  BucketUso,
  DatosUso,
  EvaluacionCuota,
  GrupoUso,
  RespuestaUsageAgy,
} from "./cuotaManager.js";

