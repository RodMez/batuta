# Batuta

Batuta es un sistema orquestador de agentes de IA diseñado para dirigir agentes como un director a su orquesta: el flujo y los límites los controla código determinista, mientras los modelos ejecutan tareas cognitivas acotadas y verificadas con comandos automáticos.

Este repositorio es un monorepo TypeScript estructurado con **npm workspaces**.

---

## Estructura del Proyecto

```
batuta/
├── packages/
│   ├── core/      # Núcleo: lógica del motor, estado, eventos, interfaces y gates
│   └── cli/       # CLI delgada construida sobre el núcleo
├── docs/
│   ├── briefs/    # Briefs de especificación por hito
│   ├── decisiones/# Registro de decisiones de arquitectura (ADRs)
│   └── diseno.md  # Documento general de diseño y arquitectura
├── .github/
│   └── workflows/ # CI automatizado para Linux (Ubuntu) y Windows
└── AGENTS.md      # Reglas para agentes de codificación en el proyecto
```

---

## Requisitos de Entorno

- **Node.js**: `>= 22.0.0`
- **npm**: `>= 10.0.0`
- **Git**: Configurado con finales de línea LF (`* text=auto eol=lf`)

---

## Instalación y Verificación

### 1. Instalación limpia
```bash
npm ci
```

### 2. Pipeline unificado de verificación
Ejecuta secuencialmente linting, tipado estático, suite de pruebas y compilación:
```bash
npm run verify
```

### 3. Comandos individuales
- **Lint**: `npm run lint` (ESLint con TypeScript estricto, sin `any` explícito)
- **Tipos**: `npm run typecheck` (`tsc --build --noEmit`)
- **Pruebas**: `npm test` (Vitest)
- **Compilación**: `npm run build` (`tsc --build` a carpetas `dist/`)

---

## Ejecución de la CLI

Una vez compilado el proyecto con `npm run build`:
```bash
node packages/cli/dist/index.js --version
```
Muestra la versión actual de Batuta (`0.1.0`).
