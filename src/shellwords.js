import { readWord } from "./shellexpand.js";

const OPERATORS = ["&&", "||", ";;", "|&", ";", "|", "&", "(", ")", "\n"];
const REDIRECT_PATTERN = /^(\d*)(&>>|&>|>>|>\||>&|<&|<<-|<<<|<<|<>|>|<)/;

export function parseShell(text, environment) {
  return new ShellScanner(text, environment).parse();
}

class ShellScanner {
  constructor(text, environment) {
    this.cursor = { text, index: 0, environment, substitutions: [], variables: [] };
    this.commands = [];
    this.heredocs = [];
    this.pendingRedirect = null;
    this.command = newCommand();
  }

  parse() {
    const { cursor } = this;
    while (cursor.index < cursor.text.length) this.readToken();
    this.endCommand();
    return { commands: this.commands, substitutions: cursor.substitutions, variables: cursor.variables };
  }

  readToken() {
    const rest = this.cursor.text.slice(this.cursor.index);
    const redirect = REDIRECT_PATTERN.exec(rest);
    const operator = OPERATORS.find((candidate) => rest.startsWith(candidate));
    if (rest[0] === " " || rest[0] === "\t") this.cursor.index++;
    else if (rest[0] === "#") this.skipComment();
    else if (redirect) this.startRedirect(redirect);
    else if (operator) this.readOperator(operator);
    else this.addWord(readWord(this.cursor));
  }

  skipComment() {
    const lineEnd = this.cursor.text.indexOf("\n", this.cursor.index);
    this.cursor.index = lineEnd === -1 ? this.cursor.text.length : lineEnd;
  }

  startRedirect(match) {
    this.cursor.index += match[0].length;
    this.pendingRedirect = { fd: match[1], op: match[2] };
  }

  readOperator(operator) {
    this.cursor.index += operator.length;
    this.endCommand();
    if (operator === "\n") this.readHeredocBodies();
  }

  addWord(word) {
    const redirect = this.pendingRedirect;
    this.pendingRedirect = null;
    if (!redirect) this.command.words.push(word);
    else if (redirect.op === "<<" || redirect.op === "<<-") this.heredocs.push({ command: this.command, delimiter: word, stripTabs: redirect.op === "<<-" });
    else this.command.redirects.push({ ...redirect, target: word });
  }

  endCommand() {
    if (this.command.words.length > 0 || this.command.redirects.length > 0) this.commands.push(this.command);
    this.command = newCommand();
  }

  readHeredocBodies() {
    for (const heredoc of this.heredocs) heredoc.command.heredocBodies.push(this.readHeredocBody(heredoc));
    this.heredocs = [];
  }

  readHeredocBody({ delimiter, stripTabs }) {
    const { cursor } = this;
    const lines = [];
    while (cursor.index < cursor.text.length) {
      const lineEnd = cursor.text.indexOf("\n", cursor.index);
      const end = lineEnd === -1 ? cursor.text.length : lineEnd;
      const line = cursor.text.slice(cursor.index, end);
      cursor.index = end + 1;
      if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
      lines.push(line);
    }
    return lines.join("\n");
  }
}

function newCommand() {
  return { words: [], redirects: [], heredocBodies: [] };
}
