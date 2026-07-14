/**
 * Coding Agent — CLI-агент для работы с кодом на Claude API.
 *
 * Инструменты (выполняются локально, на вашей машине):
 *   - bash        — выполнение shell-команд (каждая требует подтверждения y/n)
 *   - text editor — чтение, создание и правка файлов (только внутри WORKSPACE)
 *
 * Запуск:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   npm start                  # рабочая папка = текущая
 *   npm start -- /path/to/dir  # или явно указать рабочую папку
 */
import Anthropic from "@anthropic-ai/sdk";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";

const client = new Anthropic();

const WORKSPACE = path.resolve(process.argv[2] ?? process.cwd());
const MODEL = "claude-opus-4-8";
const MAX_TOOL_ROUNDS = 50; // предохранитель от бесконечного цикла за один ход

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const SYSTEM_PROMPT = `You are a coding agent working in the directory ${WORKSPACE}.
Use the text editor tool to read and modify files, and the bash tool to run commands
(tests, git, package managers). The bash session is NOT persistent between commands:
"cd" does not carry over, so use paths relative to the workspace or absolute paths.
After making changes, verify them (run tests or typecheck when available).
Be concise in your replies.`;

// ---------------------------------------------------------------------------
// Text editor tool — все пути жёстко ограничены рабочей папкой
// ---------------------------------------------------------------------------

/** Приводит путь от модели к абсолютному и проверяет, что он внутри WORKSPACE. */
function resolveSafePath(p: string): string {
  const abs = path.resolve(WORKSPACE, p);
  const rel = path.relative(WORKSPACE, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the workspace: ${p}`);
  }
  return abs;
}

interface EditorInput {
  command: "view" | "create" | "str_replace" | "insert";
  path: string;
  view_range?: [number, number];
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  insert_text?: string;
}

function runTextEditor(input: EditorInput): string {
  const target = resolveSafePath(input.path);

  switch (input.command) {
    case "view": {
      if (fs.statSync(target).isDirectory()) {
        return fs.readdirSync(target).join("\n");
      }
      const lines = fs.readFileSync(target, "utf8").split("\n");
      let [from, to] = input.view_range ?? [1, lines.length];
      if (to === -1) to = lines.length;
      return lines
        .slice(from - 1, to)
        .map((l, i) => `${from + i}\t${l}`)
        .join("\n");
    }
    case "create": {
      if (fs.existsSync(target)) {
        fs.copyFileSync(target, target + ".bak");
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, input.file_text ?? "");
      return `Created ${input.path}`;
    }
    case "str_replace": {
      const content = fs.readFileSync(target, "utf8");
      const old = input.old_str ?? "";
      const count = content.split(old).length - 1;
      if (count === 0) throw new Error("old_str not found in file");
      if (count > 1) throw new Error(`old_str matches ${count} times; must match exactly once`);
      fs.writeFileSync(target, content.replace(old, input.new_str ?? ""));
      return `Edited ${input.path}`;
    }
    case "insert": {
      const lines = fs.readFileSync(target, "utf8").split("\n");
      const at = input.insert_line ?? 0; // 0 = начало файла
      lines.splice(at, 0, ...(input.insert_text ?? "").split("\n"));
      fs.writeFileSync(target, lines.join("\n"));
      return `Inserted text after line ${at} in ${input.path}`;
    }
    default:
      throw new Error(`Unsupported editor command: ${(input as EditorInput).command}`);
  }
}

// ---------------------------------------------------------------------------
// Bash tool — каждая команда показывается и требует подтверждения
// ---------------------------------------------------------------------------

interface BashInput {
  command?: string;
  restart?: boolean;
}

async function runBash(input: BashInput): Promise<string> {
  if (input.restart) {
    return "Shell session restarted (each command already runs in a fresh shell).";
  }
  const command = input.command ?? "";

  console.log(`\n  $ ${command}`);
  const answer = (await rl.question("  Выполнить? [y/N] ")).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    return "User declined to run this command. Ask for an alternative or explain why it is needed.";
  }

  const result = spawnSync("/bin/bash", ["-c", command], {
    cwd: WORKSPACE,
    timeout: 120_000,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const status = result.status === 0 ? "" : `\n(exit code: ${result.status})`;
  // Ограничиваем объём, чтобы огромный вывод не съел контекст
  const truncated = output.length > 30_000 ? output.slice(0, 30_000) + "\n...[truncated]" : output;
  return (truncated || "(no output)") + status;
}

// ---------------------------------------------------------------------------
// Агентный цикл: запрос → tool_use → выполнить → tool_result → повторить
// ---------------------------------------------------------------------------

async function executeTool(block: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
  try {
    let output: string;
    if (block.name === "bash") {
      output = await runBash(block.input as BashInput);
    } else if (block.name === "str_replace_based_edit_tool") {
      output = runTextEditor(block.input as EditorInput);
    } else {
      throw new Error(`Unknown tool: ${block.name}`);
    }
    return { type: "tool_result", tool_use_id: block.id, content: output };
  } catch (err) {
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: err instanceof Error ? err.message : String(err),
      is_error: true,
    };
  }
}

async function runTurn(messages: Anthropic.MessageParam[]): Promise<void> {
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      tools: [
        { type: "bash_20250124", name: "bash" },
        { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
      ],
      messages,
    });

    for (const block of response.content) {
      if (block.type === "text") console.log(block.text);
    }

    if (response.stop_reason === "max_tokens") {
      console.log("\n[Ответ обрезан по max_tokens]");
      return;
    }
    if (response.stop_reason !== "tool_use") return; // end_turn — ход завершён

    messages.push({ role: "assistant", content: response.content });

    const toolBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolBlocks) {
      results.push(await executeTool(block));
    }
    messages.push({ role: "user", content: results });
  }
  console.log("\n[Достигнут лимит вызовов инструментов за один ход]");
}

// ---------------------------------------------------------------------------
// Интерактивный REPL
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Coding agent (${MODEL})`);
  console.log(`Рабочая папка: ${WORKSPACE}`);
  console.log(`Опишите задачу ("exit" — выход).\n`);

  const messages: Anthropic.MessageParam[] = [];

  while (true) {
    let userInput: string;
    try {
      userInput = (await rl.question("> ")).trim();
    } catch {
      break; // stdin закрыт (Ctrl+D)
    }
    if (!userInput) continue;
    if (userInput === "exit" || userInput === "quit") break;

    messages.push({ role: "user", content: userInput });
    try {
      await runTurn(messages);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        console.error("Неверный или отсутствующий API-ключ. Установите ANTHROPIC_API_KEY.");
      } else if (err instanceof Anthropic.RateLimitError) {
        console.error("Превышен лимит запросов — подождите и повторите.");
      } else if (err instanceof Anthropic.APIError) {
        console.error(`Ошибка API (${err.status}): ${err.message}`);
      } else {
        console.error("Ошибка:", err);
      }
    }
    console.log();
  }

  rl.close();
}

main();
