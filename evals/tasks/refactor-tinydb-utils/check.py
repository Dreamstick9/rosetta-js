import ast
import importlib
import pathlib
import sys

MOVED = {"LRUCache", "FrozenDict", "freeze"}
problems = []


def names_in(path):
    tree = ast.parse(pathlib.Path(path).read_text())
    defined = {node.name for node in tree.body if isinstance(node, (ast.ClassDef, ast.FunctionDef))}
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported |= {(node.module or "", alias.name) for alias in node.names}
    return defined, imported


def check_module(path, expected):
    if not pathlib.Path(path).exists():
        problems.append(f"{path} does not exist")
        return
    defined, _ = names_in(path)
    missing = expected - defined
    if missing:
        problems.append(f"{path} does not define {sorted(missing)}")


check_module("tinydb/cache.py", {"LRUCache"})
check_module("tinydb/frozen.py", {"FrozenDict", "freeze"})

defined, imported = names_in("tinydb/utils.py")
if "with_typehint" not in defined:
    problems.append("tinydb/utils.py lost with_typehint")
leftovers = (defined | {name for _, name in imported}) & MOVED
if leftovers:
    problems.append(f"tinydb/utils.py still has {sorted(leftovers)}")

for path in list(pathlib.Path("tinydb").glob("*.py")) + list(pathlib.Path("tests").glob("*.py")):
    _, imported = names_in(path)
    stale = [name for module, name in imported if module.endswith("utils") and name in MOVED]
    if stale:
        problems.append(f"{path} imports {stale} from utils")

for path in ["tests/test_cache.py", "tests/test_frozen.py"]:
    if not pathlib.Path(path).exists():
        problems.append(f"{path} does not exist")

sys.path.insert(0, ".")
utils = importlib.import_module("tinydb.utils")
if any(hasattr(utils, name) for name in MOVED):
    problems.append("tinydb.utils still exposes a moved name")

if problems:
    print("\n".join(problems))
    sys.exit(1)
print("structure OK")
