import fs from "node:fs";
import { CONFIG, PROJECT_ROOT } from "../config.js";
import { findTestCommand } from "../checks.js";
import { handleCommand } from "../slash.js";
import { resolvePath } from "../tools/files.js";
import { setUiSink } from "../ui.js";
import * as cells from "./cells.js";
import { Composer } from "./composer.js";
import { renderGitDiff } from "./diff.js";
import { listProjectFiles, rankFiles } from "./files.js";
import { readGitDiff } from "./gitdiff.js";
import { KeyParser } from "./keys.js";
import { MarkdownStream } from "./markdown.js";
import { Picker } from "./picker.js";
import { SLASH_COMMANDS, filterSlashCommands, findSlashCommand, parseSlashInput } from "./slash.js";
import { TRUE_COLOR, rgb, serialize, span, spansWidth, style, textWidth, truncateSpans } from "./text.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const EXPLORE_TOOLS = new Set(["read_file", "list_files", "search"]);
const FILE_CHANGE_TOOLS = new Set(["create_file", "write_file", "edit_file", "delete_file"]);
const FRAME_MS = 80;
const QUIT_HINT_MS = 2000;
const QUIT_FALLBACK_MS = 3000;
const MAX_DIFF_SOURCE_BYTES = 512_000;
const MAX_COMPOSER_ROWS = 10;
const MAX_POPUP_ROWS = 8;
const MODEL_LIST_TIMEOUT_MS = 15_000;
const PLACEHOLDER = "Ask rosetta to do anything";
const DIM = style("dim");
const BOLD = style("bold");
const CYAN = style("cyan");
const POLICY_CHOICES = [
  { value: "standard", label: "Standard", description: "block writes outside the project and /tmp, git push, credential files and secret variables" },
  { value: "off", label: "Full access", description: "no policy checks: every command and file operation runs" },
];
const TERMINAL_ON = "\x1b[?2004h\x1b[>1u";
const TERMINAL_OFF = "\x1b[<u\x1b[?2004l\x1b[?25h";

export class Tui {
  constructor() {
    this.startupNotes = [];
    this.started = false;
    this.closed = false;
    this.pending = [];
    this.transcript = [];
    this.liveCursorRow = 0;
    this.liveCursorColumn = 0;
    this.liveWidths = [];
    this.lastWidth = terminalWidth();
    this.composer = new Composer();
    this.parser = new KeyParser();
    this.popup = null;
    this.popupDismissedFor = null;
    this.view = null;
    this.overlay = null;
    this.busy = false;
    this.queue = [];
    this.stream = null;
    this.reasoningText = "";
    this.statusHeader = "Working";
    this.explore = null;
    this.running = new Map();
    this.checkRunning = null;
    this.quitArmedUntil = 0;
    this.contextUsed = 0;
    this.renderQueued = false;
    this.onData = (data) => this.guard(() => this.handleData(data));
    this.onResize = () => this.guard(() => this.handleResize());
    this.restoreTerminal = () => this.restore();
    setUiSink(this);
  }

  run({ agent, trace, keepChatting, runTask }) {
    Object.assign(this, { agent, trace, keepChatting, runTask });
    return new Promise((resolve) => {
      this.resolveRun = resolve;
      this.start();
    });
  }

  start() {
    this.started = true;
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", this.onData);
    process.stdin.resume();
    process.stdout.on("resize", this.onResize);
    process.on("exit", this.restoreTerminal);
    process.stdout.write(TERMINAL_ON);
    this.refreshContext();
    const header = cells.headerCell({
      version: VERSION,
      model: CONFIG.model,
      directory: cells.tildify(PROJECT_ROOT),
      policy: CONFIG.policy,
      keepChatting: this.keepChatting,
      notes: this.startupNotes,
    }, this.contentWidth());
    this.commitLines(header);
    this.render();
  }

  guard(action) {
    try {
      action();
    } catch (error) {
      this.restore();
      process.stderr.write(`\nrosetta TUI crashed: ${error.stack}\n`);
      process.exit(1);
    }
  }

  contentWidth() {
    return Math.max(20, terminalWidth() - 1);
  }

  // Backend events (see src/ui.js)

  text(chunk) {
    this.flushReasoning();
    this.closeExplore();
    this.statusHeader = "Working";
    this.stream ??= { markdown: new MarkdownStream(), buffer: "", bulletShown: false, blankLines: 0 };
    this.stream.buffer += chunk;
    let newline = this.stream.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stream.buffer.slice(0, newline);
      this.stream.buffer = this.stream.buffer.slice(newline + 1);
      this.commitStreamLine(line);
      newline = this.stream.buffer.indexOf("\n");
    }
    this.scheduleRender();
  }

  reasoning(chunk) {
    this.reasoningText += chunk ?? "";
    const headers = [...this.reasoningText.matchAll(/\*\*([^*\n]{1,80})\*\*/g)];
    this.statusHeader = headers.length > 0 ? headers.at(-1)[1] : "Thinking";
    this.scheduleRender();
  }

  notice(text, kind) {
    if (!this.started) {
      this.startupNotes.push(text);
      return;
    }
    this.flushActive();
    if (text.startsWith("[retry]")) this.statusHeader = "Reconnecting";
    this.commitCell(cells.noticeCell(text, kind, this.contentWidth()));
  }

  toolStart(call) {
    this.flushReasoning();
    this.flushStream();
    if (EXPLORE_TOOLS.has(call.name)) {
      this.explore ??= { entries: [] };
      this.explore.entries.push({ id: call.id, call, status: "running", output: "" });
      this.statusHeader = "Exploring";
    } else {
      this.closeExplore();
      this.running.set(call.id, { call, before: readSource(call) });
      this.statusHeader = call.name === "bash" ? "Running" : "Editing";
    }
    this.scheduleRender();
  }

  toolEnd(result) {
    this.flushReasoning();
    this.flushStream();
    if (EXPLORE_TOOLS.has(result.name) && result.status !== "blocked") {
      this.explore ??= { entries: [] };
      let entry = this.explore.entries.find((item) => item.id === result.id && item.status === "running");
      if (!entry) {
        entry = { id: result.id, call: { name: result.name, args: result.args } };
        this.explore.entries.push(entry);
      }
      entry.status = result.status;
      entry.output = result.output;
    } else {
      this.closeExplore();
      const started = this.running.get(result.id);
      this.running.delete(result.id);
      this.commitCell(this.renderToolResult(result, started));
    }
    this.statusHeader = "Working";
    this.refreshContext();
    this.scheduleRender();
  }

  checkStart(command) {
    this.flushActive();
    this.checkRunning = command;
    this.statusHeader = "Running tests";
    this.scheduleRender();
  }

  checkEnd(result) {
    this.checkRunning = null;
    this.statusHeader = "Working";
    this.commitCell(cells.checkCell(result, this.contentWidth()));
  }

  taskEnd(result) {
    this.flushActive();
    this.refreshContext();
    this.commitCell([cells.turnSummaryLine(result, this.contentWidth())]);
  }

  interrupted() {
    this.flushActive();
    this.running.clear();
    this.commitCell(cells.interruptedCell(this.contentWidth()));
  }

  // Active cells

  commitStreamLine(line) {
    const stream = this.stream;
    if (!line.trim() && !stream.markdown.inFence) {
      if (stream.bulletShown) stream.blankLines++;
      return;
    }
    const firstPrefix = [span(stream.bulletShown ? "  " : "• ")];
    const rendered = stream.markdown.renderLine(line, this.contentWidth(), firstPrefix, [span("  ")]);
    if (rendered.length === 0) return;
    const lead = stream.bulletShown ? Array.from({ length: stream.blankLines }, () => []) : [[]];
    stream.blankLines = 0;
    stream.bulletShown = true;
    this.commitLines([...lead, ...rendered]);
  }

  flushStream() {
    if (!this.stream) return;
    if (this.stream.buffer) this.commitStreamLine(this.stream.buffer);
    this.stream = null;
  }

  flushReasoning() {
    if (this.reasoningText.trim()) this.transcript.push([], ...cells.reasoningLines(this.reasoningText, this.contentWidth()));
    this.reasoningText = "";
  }

  closeExplore() {
    if (!this.explore) return;
    const entries = this.explore.entries;
    this.explore = null;
    this.commitCell(cells.exploreLines(entries, true, this.contentWidth()));
  }

  flushActive() {
    this.flushReasoning();
    this.flushStream();
    this.closeExplore();
    this.checkRunning = null;
  }

  renderToolResult(result, started) {
    const width = this.contentWidth();
    if (result.status === "blocked") return cells.blockedCell(result, width);
    if (result.name === "bash") return cells.execCell(result, width);
    if (FILE_CHANGE_TOOLS.has(result.name)) {
      const before = started ? started.before : undefined;
      const after = result.status === "ok" && result.name !== "delete_file" ? readSource({ name: result.name, args: result.args }) : null;
      return cells.fileChangeCell(result, before === undefined ? "" : before, after, width);
    }
    return cells.genericToolCell(result, width);
  }

  commitLines(lines) {
    for (const line of lines) {
      this.pending.push(serialize(line));
      this.transcript.push(line);
    }
    this.scheduleRender();
  }

  commitCell(lines) {
    this.commitLines([[], ...lines]);
  }

  // Turns

  async startTurn(item) {
    this.busy = true;
    this.turnStartedAt = Date.now();
    this.statusHeader = "Working";
    this.commitCell(cells.userCell(item.display, this.contentWidth()));
    this.controller = new AbortController();
    this.animation = setInterval(() => this.scheduleRender(), FRAME_MS);
    await this.runTask(item.text, this.controller.signal);
    this.guard(() => this.endTurn());
  }

  endTurn() {
    this.flushActive();
    this.running.clear();
    clearInterval(this.animation);
    this.busy = false;
    this.controller = null;
    this.refreshContext();
    if (this.quitting || !this.keepChatting) return this.finish();
    const next = this.queue.shift();
    if (next) return this.startTurn(next);
    this.scheduleRender();
  }

  interrupt() {
    if (!this.controller) return;
    this.controller.abort();
    if (this.queue.length > 0 && !this.quitting) {
      const queued = this.queue.map((item) => item.text).join("\n\n");
      this.queue = [];
      this.composer.setText(this.composer.isEmpty() ? queued : `${queued}\n\n${this.composer.text}`);
    }
  }

  quit() {
    if (!this.busy) return this.finish();
    this.quitting = true;
    this.interrupt();
    setTimeout(() => this.finish(), QUIT_FALLBACK_MS).unref();
  }

  finish() {
    if (this.closed) return;
    this.flushActive();
    const totals = this.trace.totals;
    const summary = [
      `Token usage: total=${totals.inputTokens + totals.outputTokens} input=${totals.inputTokens} (+${totals.cachedTokens} cached) output=${totals.outputTokens} · cost $${totals.cost.toFixed(4)}`,
    ];
    if (this.trace.file) summary.push(`Trace: ${cells.tildify(this.trace.file)}`);
    let output = `\r${this.liveCursorRow > 0 ? `\x1b[${this.liveCursorRow}A` : ""}\x1b[J`;
    for (const line of this.pending) output += `${line}\r\n`;
    output += `\r\n${summary.map((line) => serialize([span(line, DIM)])).join("\r\n")}\r\n`;
    this.pending = [];
    process.stdout.write(output);
    this.restore();
    setUiSink(null);
    this.resolveRun();
  }

  restore() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.animation);
    if (this.overlay) process.stdout.write("\x1b[?1049l");
    process.stdout.write(TERMINAL_OFF);
    process.stdout.off("resize", this.onResize);
    process.stdin.off("data", this.onData);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  // Input

  handleData(data) {
    for (const key of this.parser.feed(data)) {
      if (this.closed) return;
      this.handleKey(key);
    }
    this.scheduleRender();
  }

  handleKey(key) {
    if (this.overlay) return this.handleOverlayKey(key);
    if (this.view) return this.view.handleKey(key);
    if (key.name === "paste") {
      this.composer.insertPaste(key.text);
      return this.updatePopup();
    }
    if (this.popup && this.handlePopupKey(key)) return;
    if (key.ctrl && key.name === "c") return this.handleCtrlC();
    if (key.ctrl && key.name === "d") return this.composer.isEmpty() ? this.quit() : this.composer.deleteForward();
    if (key.ctrl && key.name === "t") return this.openOverlay();
    if (key.ctrl && key.name === "l") return this.clearScreen();
    if (key.name === "escape") return this.busy ? this.interrupt() : undefined;
    if (key.name === "enter" && !key.shift && !key.alt) return this.submit();
    this.editComposer(key);
    this.updatePopup();
  }

  editComposer(key) {
    const composer = this.composer;
    const available = this.composerTextWidth();
    const name = key.name;
    if (name === "enter" || (key.ctrl && name === "j")) composer.insert("\n");
    else if (name === "up" || (key.ctrl && name === "p")) composer.moveVertical(-1, available) || composer.historyPrevious();
    else if (name === "down" || (key.ctrl && name === "n")) composer.moveVertical(1, available) || composer.historyNext();
    else if (name === "left" && (key.alt || key.ctrl)) composer.wordLeft();
    else if (name === "right" && (key.alt || key.ctrl)) composer.wordRight();
    else if (name === "left" || (key.ctrl && name === "b")) composer.moveLeft();
    else if (name === "right" || (key.ctrl && name === "f")) composer.moveRight();
    else if (key.alt && name === "b") composer.wordLeft();
    else if (key.alt && name === "f") composer.wordRight();
    else if (name === "home" || (key.ctrl && name === "a")) composer.cursor = composer.lineStart();
    else if (name === "end" || (key.ctrl && name === "e")) composer.cursor = composer.lineEnd();
    else if (name === "backspace" && (key.alt || key.ctrl)) composer.deleteWordBack();
    else if (key.ctrl && name === "w") composer.deleteWordBack();
    else if (name === "backspace" || (key.ctrl && name === "h")) composer.backspace();
    else if (name === "delete") composer.deleteForward();
    else if (key.ctrl && name === "u") composer.killToLineStart();
    else if (key.ctrl && name === "k") composer.killToLineEnd();
    else if (key.text && !key.ctrl && !key.alt) composer.insert(key.text);
  }

  handleCtrlC() {
    if (this.busy) return this.interrupt();
    if (!this.composer.isEmpty()) {
      this.composer.clear();
      return this.updatePopup();
    }
    if (Date.now() < this.quitArmedUntil) return this.quit();
    this.quitArmedUntil = Date.now() + QUIT_HINT_MS;
    setTimeout(() => this.scheduleRender(), QUIT_HINT_MS + 10).unref();
  }

  submit() {
    const { text, display } = this.composer.take();
    this.popup = null;
    this.popupDismissedFor = null;
    if (!text.trim()) return;
    if (display.trim().startsWith("/") && !display.trim().includes("\n")) {
      const { name, argument } = parseSlashInput(display);
      return this.runSlashCommand(name, argument);
    }
    if (this.busy) this.queue.push({ text, display });
    else this.startTurn({ text, display });
  }

  // Popups

  updatePopup() {
    const next = this.computePopup();
    if (next && this.popup?.kind === next.kind && this.popup.query === next.query) next.index = Math.min(this.popup.index, next.items.length - 1);
    this.popup = next;
  }

  computePopup() {
    const text = this.composer.text;
    if (this.popupDismissedFor === text) return null;
    this.popupDismissedFor = null;
    if (/^\/\S*$/.test(text)) {
      const items = filterSlashCommands(text.slice(1));
      return items.length > 0 ? { kind: "slash", query: text, items, index: 0 } : null;
    }
    const token = this.composer.tokenBeforeCursor();
    if (!token.text.startsWith("@")) return null;
    const query = token.text.slice(1);
    return { kind: "file", query, start: token.start, items: rankFiles(listProjectFiles(PROJECT_ROOT), query, MAX_POPUP_ROWS), index: 0 };
  }

  handlePopupKey(key) {
    const popup = this.popup;
    if (key.name === "up" || (key.ctrl && key.name === "p")) popup.index = Math.max(0, popup.index - 1);
    else if (key.name === "down" || (key.ctrl && key.name === "n")) popup.index = Math.min(popup.items.length - 1, popup.index + 1);
    else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      this.popupDismissedFor = this.composer.text;
      this.popup = null;
    } else if ((key.name === "tab" || key.name === "enter") && !key.shift && popup.items.length > 0) this.acceptPopup(key.name);
    else return false;
    return true;
  }

  acceptPopup(keyName) {
    const popup = this.popup;
    const item = popup.items[popup.index];
    this.popup = null;
    if (popup.kind === "file") {
      const inserted = /\s/.test(item.path) ? `"${item.path}"` : item.path;
      this.composer.replaceRange(popup.start, this.composer.cursor, `${inserted} `);
      return;
    }
    if (keyName === "tab") {
      this.composer.setText(`/${item.name} `);
      return;
    }
    this.composer.clear();
    this.runSlashCommand(item.name, "");
  }

  // Slash commands

  runSlashCommand(name, argument) {
    const width = this.contentWidth();
    const command = findSlashCommand(name);
    if (!command) return this.commitCell(cells.noticeCell(`Unrecognized command '/${name}'. Type "/" for a list of commands.`, "error", width));
    if (this.busy && !command.whileBusy) return this.commitCell(cells.noticeCell(`'/${name}' is disabled while a task is in progress.`, "error", width));
    if (command.name === "model") return this.openModelPicker();
    if (command.name === "approvals") return this.openPolicyPicker();
    if (command.name === "new") return this.startNewConversation();
    if (command.name === "compact") return this.compactConversation();
    if (command.name === "undo") return handleCommand(this.agent, this.trace, "/undo");
    if (command.name === "resume" || command.name === "best-of") return this.startTaskCommand(name, argument);
    if (command.name === "diff") return this.showDiff();
    if (command.name === "mention") {
      this.composer.insert(this.composer.isEmpty() || /\s$/.test(this.composer.text) ? "@" : " @");
      return this.updatePopup();
    }
    if (command.name === "status") return this.commitCell(cells.statusCell(this.statusInfo(), width));
    if (command.name === "cost") return this.commitCell(cells.costCell(this.trace.totals, this.trace.file, width));
    if (command.name === "check") return this.setCheck(argument);
    if (command.name === "help") return this.commitCell(cells.helpCell(SLASH_COMMANDS, width));
    return this.quit();
  }

  startTaskCommand(name, argument) {
    const text = argument ? `/${name} ${argument}` : `/${name}`;
    this.startTurn({ text, display: text });
  }

  notify(text, kind = "dim") {
    this.commitCell(cells.noticeCell(text, kind, this.contentWidth()));
  }

  startNewConversation() {
    this.agent.reset();
    this.refreshContext();
    this.notify("Started a new conversation.");
  }

  compactConversation() {
    if (this.agent.messages.length <= 1) return this.notify("Nothing to compact yet.");
    this.agent.compact();
    this.refreshContext();
  }

  showDiff() {
    const result = readGitDiff(PROJECT_ROOT);
    if (result.error) return this.notify(result.error, "error");
    if (!result.text.trim()) return this.notify("No changes.");
    this.commitCell([[span("• ", DIM), span("Git diff", BOLD)], [], ...renderGitDiff(result.text, this.contentWidth())]);
  }

  setCheck(argument) {
    if (!["", "on", "off"].includes(argument)) return this.notify("Usage: /check on | /check off", "error");
    this.agent.doneCheckEnabled = argument === "" ? !this.agent.doneCheckEnabled : argument === "on";
    this.notify(`Test check after changes is ${this.agent.doneCheckEnabled ? "on" : "off"}.`);
  }

  statusInfo() {
    const testCommand = this.agent.doneCheckEnabled ? findTestCommand() : null;
    return {
      version: VERSION,
      model: CONFIG.model,
      overrides: CONFIG.overrides,
      baseUrl: CONFIG.baseUrl,
      directory: cells.tildify(PROJECT_ROOT),
      policy: CONFIG.policy,
      check: this.agent.doneCheckEnabled ? `on · ${testCommand ?? "no test command found"}` : "off",
      limits: `${CONFIG.maxTurns} model calls per task · $${CONFIG.maxSessionUsd} per session`,
      trace: this.trace.file ? cells.tildify(this.trace.file) : "(nothing recorded yet)",
      totals: this.trace.totals,
      contextUsed: this.contextUsed,
      maxContextTokens: CONFIG.maxContextTokens,
    };
  }

  openModelPicker() {
    const picker = new Picker({
      title: "Select Model",
      subtitle: `Models served by ${CONFIG.baseUrl}. Cost reporting keeps using pricing from config.json.`,
      searchable: true,
      onSelect: (item) => {
        this.view = null;
        this.setModel(item.value);
      },
      onCancel: () => {
        this.view = null;
      },
    });
    this.view = picker;
    fetchModelIds(CONFIG).then(
      (ids) => {
        picker.setItems(ids.map((id) => ({ label: id, value: id, current: id === CONFIG.model })));
        this.scheduleRender();
      },
      (error) => {
        if (this.view === picker) this.view = null;
        this.notify(`Could not load the model list: ${error.message}`, "error");
      },
    );
  }

  setModel(model) {
    if (model === CONFIG.model) return;
    CONFIG.model = model;
    this.trace.write({ type: "setting", model });
    this.notify(`Model changed to ${model}.`);
  }

  openPolicyPicker() {
    this.view = new Picker({
      title: "Select Approval Mode",
      subtitle: "What the agent may do without being blocked. Applies from the next tool call.",
      items: POLICY_CHOICES.map((choice) => ({ ...choice, current: choice.value === CONFIG.policy })),
      onSelect: (item) => {
        this.view = null;
        this.setPolicy(item.value);
      },
      onCancel: () => {
        this.view = null;
      },
    });
  }

  setPolicy(policy) {
    if (policy === CONFIG.policy) return;
    CONFIG.policy = policy;
    this.trace.write({ type: "setting", policy });
    this.notify(`Policy set to ${policy === "off" ? "full access (no checks)" : "standard"}.`);
  }

  refreshContext() {
    if (this.agent) this.contextUsed = this.agent.estimateContextTokens();
  }

  contextPercentLeft() {
    return Math.max(0, Math.min(100, Math.round(100 - (this.contextUsed / CONFIG.maxContextTokens) * 100)));
  }

  // Transcript overlay

  openOverlay() {
    this.overlay = { scroll: Infinity };
    process.stdout.write("\x1b[?1049h\x1b[?25l");
  }

  closeOverlay() {
    this.overlay = null;
    process.stdout.write("\x1b[?1049l");
  }

  handleOverlayKey(key) {
    const page = Math.max(1, terminalHeight() - 2);
    const overlay = this.overlay;
    const maxScroll = Math.max(0, this.transcript.length - page);
    const current = Math.min(overlay.scroll, maxScroll);
    const name = key.name;
    if (name === "escape" || name === "q" || (key.ctrl && (name === "t" || name === "c"))) return this.closeOverlay();
    if (name === "up" || name === "k") overlay.scroll = Math.max(0, current - 1);
    else if (name === "down" || name === "j") overlay.scroll = current + 1;
    else if (name === "pageup" || name === "b") overlay.scroll = Math.max(0, current - page);
    else if (name === "pagedown" || name === " ") overlay.scroll = current + page;
    else if (name === "home" || name === "g") overlay.scroll = 0;
    else if (name === "end" || key.text === "G") overlay.scroll = Infinity;
    if (overlay.scroll >= maxScroll) overlay.scroll = Infinity;
  }

  renderOverlay() {
    const width = terminalWidth();
    const height = terminalHeight();
    const page = Math.max(1, height - 2);
    const maxScroll = Math.max(0, this.transcript.length - page);
    const scroll = Math.min(this.overlay.scroll, maxScroll);
    const title = "/ T R A N S C R I P T ";
    let output = "\x1b[?2026h\x1b[H";
    output += `${serialize([span(title + "/ ".repeat(Math.max(0, Math.floor((width - 1 - title.length) / 2))), DIM)])}\x1b[K\r\n`;
    for (let row = 0; row < page; row++) {
      const line = this.transcript[scroll + row] ?? [];
      output += `${serialize(truncateSpans(line, width - 1))}\x1b[K\r\n`;
    }
    const percent = maxScroll === 0 ? 100 : Math.round((scroll / maxScroll) * 100);
    const hints = "  ↑/↓ scroll · PgUp/PgDn page · Home/End jump · q to close";
    output += `${serialize(footerSpans(hints, `${percent}%`, width - 1))}\x1b[K\x1b[?2026l`;
    process.stdout.write(output);
  }

  // Rendering

  scheduleRender() {
    if (this.renderQueued || !this.started) return;
    this.renderQueued = true;
    setImmediate(() => {
      this.renderQueued = false;
      this.guard(() => this.render());
    });
  }

  handleResize() {
    const width = terminalWidth();
    if (width < this.lastWidth && !this.overlay) {
      let row = 0;
      for (let index = 0; index < this.liveCursorRow; index++) row += Math.max(1, Math.ceil(this.liveWidths[index] / width));
      this.liveCursorRow = row + Math.floor(this.liveCursorColumn / width);
    }
    this.lastWidth = width;
    this.render();
  }

  clearScreen() {
    process.stdout.write("\x1b[2J\x1b[H");
    this.liveCursorRow = 0;
  }

  render() {
    if (this.closed) return;
    if (this.overlay) return this.renderOverlay();
    const { lines, cursor } = this.buildLiveArea();
    let output = "\x1b[?2026h\x1b[?25l\r";
    if (this.liveCursorRow > 0) output += `\x1b[${this.liveCursorRow}A`;
    output += "\x1b[J";
    for (const line of this.pending) output += `${line}\r\n`;
    this.pending = [];
    output += lines.map(serialize).join("\r\n");
    const up = lines.length - 1 - cursor.row;
    if (up > 0) output += `\x1b[${up}A`;
    output += "\r";
    if (cursor.column > 0) output += `\x1b[${cursor.column}C`;
    if (cursor.visible) output += "\x1b[?25h";
    output += "\x1b[?2026l";
    this.liveCursorRow = cursor.row;
    this.liveCursorColumn = cursor.column;
    this.liveWidths = lines.map(spansWidth);
    process.stdout.write(output);
  }

  buildLiveArea() {
    const width = this.contentWidth();
    const active = this.activeLines(width);
    const bottom = [];
    let cursor = null;
    if (this.busy) bottom.push(this.statusLine(width));
    for (const item of this.queue) bottom.push(cells.queuedLine(item.display, width));
    bottom.push([]);
    if (this.view) bottom.push(...this.view.render(width));
    else {
      const composer = this.composerLines(width);
      cursor = { row: bottom.length + composer.cursorRow, column: composer.cursorColumn, visible: true };
      bottom.push(...composer.lines, []);
      bottom.push(...(this.popup ? this.popupLines(width) : [this.footerLine(width)]));
    }
    const continuesStream = this.stream?.bulletShown && this.stream.buffer;
    const top = [...(active.length > 0 && !continuesStream ? [[]] : []), ...active, ...(this.busy ? [[]] : [])];
    const lines = [...top, ...bottom];
    cursor = cursor ? { ...cursor, row: cursor.row + top.length } : { row: lines.length - 1, column: 0, visible: false };
    const maxRows = Math.max(3, terminalHeight() - 1);
    if (lines.length > maxRows) {
      const drop = lines.length - maxRows;
      lines.splice(0, drop);
      cursor.row = Math.max(0, cursor.row - drop);
    }
    return { lines, cursor };
  }

  activeLines(width) {
    const lines = [];
    const pulse = this.pulseStyle();
    if (this.stream?.buffer) {
      const prefix = [span(this.stream.bulletShown ? "  " : "• ")];
      lines.push(...this.stream.markdown.previewLine(this.stream.buffer, width, prefix, [span("  ")]));
    }
    if (this.explore) lines.push(...cells.exploreLines(this.explore.entries, false, width, pulse));
    for (const { call } of this.running.values()) lines.push(...cells.runningLines(call, width, pulse));
    if (this.checkRunning) lines.push(...cells.runningCheckLines(this.checkRunning, width, pulse));
    return lines;
  }

  pulseStyle() {
    return Math.floor(Date.now() / 600) % 2 === 0 ? BOLD : DIM;
  }

  statusLine(width) {
    const elapsed = cells.formatElapsed((Date.now() - this.turnStartedAt) / 1000);
    const spans = [span("• ", this.pulseStyle()), ...shimmer(this.statusHeader), span(` (${elapsed} • esc to interrupt)`, DIM)];
    return truncateSpans(spans, width);
  }

  composerTextWidth() {
    return Math.max(10, this.contentWidth() - 2);
  }

  composerLines(width) {
    const prompt = span("› ", style("bold", "cyan"));
    if (this.composer.isEmpty()) {
      const placeholder = this.busy ? "Queue a follow-up message" : PLACEHOLDER;
      return { lines: [truncateSpans([prompt, span(placeholder, DIM)], width)], cursorRow: 0, cursorColumn: 2 };
    }
    const { rows, cursor } = this.composer.layout(this.composerTextWidth());
    const maxRows = Math.max(1, Math.min(MAX_COMPOSER_ROWS, terminalHeight() - 8));
    const start = Math.max(0, Math.min(cursor.row - maxRows + 1, rows.length - maxRows));
    const lines = rows.slice(start, start + maxRows).map((row, index) => [start + index === 0 ? prompt : span("  "), span(row)]);
    return { lines, cursorRow: cursor.row - start, cursorColumn: 2 + cursor.column };
  }

  popupLines(width) {
    const popup = this.popup;
    if (popup.items.length === 0) return [[span("  no matches", DIM)]];
    const start = Math.max(0, Math.min(popup.index - MAX_POPUP_ROWS + 1, popup.items.length - MAX_POPUP_ROWS));
    const shown = popup.items.slice(start, start + MAX_POPUP_ROWS);
    if (popup.kind === "file") return shown.map((item, offset) => fileRow(item, start + offset === popup.index, width));
    const nameWidth = Math.max(...popup.items.map((item) => item.name.length)) + 3;
    return shown.map((item, offset) => {
      const selected = start + offset === popup.index;
      const name = `/${item.name}`.padEnd(nameWidth);
      return truncateSpans([span(selected ? "› " : "  ", CYAN), span(name, selected ? style("bold", "cyan") : ""), span(item.description, selected ? CYAN : DIM)], width);
    });
  }

  footerLine(width) {
    let hints = "  ⏎ send   ⌃J newline   ⌃T transcript   ⌃C quit";
    if (Date.now() < this.quitArmedUntil) hints = "  ⌃C again to quit";
    else if (this.busy) hints = "  ⏎ queue message   ⌃J newline   ⌃T transcript   esc interrupt";
    return footerSpans(hints, `${this.contextPercentLeft()}% context left`, width);
  }
}

function footerSpans(left, right, width) {
  const gap = width - textWidth(left) - textWidth(right);
  if (gap < 2) return truncateSpans([span(left, DIM)], width);
  return [span(left, DIM), span(" ".repeat(gap)), span(right, DIM)];
}

function fileRow(item, selected, width) {
  const spans = [span(selected ? "› " : "  ", CYAN)];
  const matched = new Set(item.positions);
  const base = selected ? CYAN : "";
  let index = 0;
  for (const char of item.path) {
    spans.push(span(char, matched.has(index) ? style("bold", "cyan") : base));
    index += char.length;
  }
  return truncateSpans(spans, width);
}

function shimmer(text) {
  const chars = [...text];
  const period = chars.length + 12;
  const position = ((Date.now() / 70) % period) - 6;
  return chars.map((char, index) => {
    const intensity = Math.max(0, 1 - Math.abs(index - position) / 4);
    if (TRUE_COLOR) {
      const level = Math.round(130 + intensity * 125);
      return span(char, `${BOLD};${rgb(level, level, level)}`);
    }
    return span(char, intensity > 0.4 ? BOLD : "");
  });
}

function readSource(call) {
  if (!FILE_CHANGE_TOOLS.has(call.name) || typeof call.args?.path !== "string") return null;
  try {
    const file = resolvePath(call.args.path);
    if (fs.statSync(file).size > MAX_DIFF_SOURCE_BYTES) return { tooLarge: true };
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

async function fetchModelIds(config) {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/models`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`API error ${response.status}`);
  const body = await response.json();
  const ids = (body.data ?? []).map((model) => model.id).filter((id) => typeof id === "string").sort();
  return [...new Set([config.model, ...ids])];
}

function terminalWidth() {
  return process.stdout.columns || 80;
}

function terminalHeight() {
  return process.stdout.rows || 24;
}
