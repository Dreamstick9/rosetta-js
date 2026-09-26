import { PROJECT_ROOT } from "./config.js";
import { statePath } from "./state.js";
import { createShadow, runGit } from "./shadowgit.js";
import { writeError } from "./ui.js";

const SHADOW_FOLDER = "shadow.git";
const BRANCH_REF = "refs/heads/checkpoints";

export class Checkpoints {
  constructor() {
    this.enabled = false;
    this.root = null;
    this.head = null;
    this.lastTree = null;
    this.refs = [];
  }

  open() {
    if (this.root === PROJECT_ROOT) return this.enabled;
    this.root = PROJECT_ROOT;
    this.refs = [];
    this.lastTree = null;
    try {
      this.shadow = createShadow(statePath(SHADOW_FOLDER));
      this.head = this.git(["rev-parse", "--verify", "-q", BRANCH_REF], true) || null;
      this.enabled = true;
    } catch (error) {
      this.disable(error);
    }
    return this.enabled;
  }

  take(label) {
    if (!this.enabled) return null;
    try {
      const tree = this.writeTree();
      if (tree === this.lastTree) return null;
      const parents = this.head ? ["-p", this.head] : [];
      const commit = this.git(["commit-tree", tree, ...parents, "-m", label]);
      this.git(["update-ref", BRANCH_REF, commit]);
      this.head = commit;
      this.lastTree = tree;
      this.refs.push(commit);
      return commit;
    } catch (error) {
      this.disable(error);
      return null;
    }
  }

  adopt(refs) {
    this.refs = [...new Set(refs.filter(Boolean))];
  }

  latest() {
    return this.refs.at(-1) ?? null;
  }

  restore(ref) {
    if (!this.enabled || !ref) return;
    this.restoreFiles(ref);
    if (this.latest() !== ref) this.refs.push(ref);
  }

  undo() {
    if (!this.enabled) return null;
    this.take("before undo");
    if (this.refs.length < 2) return null;
    this.refs.pop();
    const target = this.latest();
    this.restoreFiles(target);
    return target;
  }

  describeDiff(fromRef, maxLines) {
    const tree = this.writeTree();
    const stat = this.git(["diff", "--no-color", "--no-ext-diff", "--stat", fromRef, tree]);
    const patch = this.git(["diff", "--no-color", "--no-ext-diff", fromRef, tree]);
    return { stat: stat || "(no changes)", patch: capLines(patch, maxLines) };
  }

  diffStat(fromRef, toRef) {
    if (!this.enabled || !fromRef || !toRef) return "";
    return this.git(["diff", "--no-color", "--shortstat", fromRef, toRef]);
  }

  restoreFiles(ref) {
    this.git(["add", "-A"]);
    this.git(["read-tree", "-u", "--reset", ref]);
    this.lastTree = this.git(["rev-parse", `${ref}^{tree}`]);
  }

  writeTree() {
    this.git(["add", "-A"]);
    return this.git(["write-tree"]);
  }

  git(args, allowFailure = false) {
    return runGit(["--git-dir", this.shadow, "--work-tree", this.root, ...args], this.root, allowFailure);
  }

  disable(error) {
    this.enabled = false;
    writeError(`Checkpoints are off: ${error.message}`);
  }
}

function capLines(text, maxLines) {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n[${lines.length - maxLines} more lines]`;
}
